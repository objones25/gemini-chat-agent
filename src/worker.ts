import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI } from '@google/genai';
import { SYSTEM_PROMPT } from './systemPrompt';

interface Env {
  GEMINI_API_KEY: string;
  CHAT_HISTORY?: KVNamespace;
  ASSETS: Fetcher;
}

interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  timestamp: number;
}

interface ChatHistory {
  sessionId: string;
  messages: ChatMessage[];
  createdAt: number;
  lastUpdated: number;
}

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for all routes
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// Handle all non-API routes with static assets
app.get('*', async (c) => {
  // Skip API routes
  if (c.req.path.startsWith('/api/')) {
    return c.notFound();
  }
  
  // Serve static assets using the ASSETS binding
  return c.env.ASSETS.fetch(c.req.raw);
});

// Helper function to clean text for TTS
function cleanTextForTTS(text: string): string {
  // Remove markdown formatting
  let cleaned = text
    .replace(/#{1,6}\s/g, '') // Remove headers
    .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold
    .replace(/\*(.*?)\*/g, '$1') // Remove italics
    .replace(/`([^`]+)`/g, '$1') // Remove inline code
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links, keep text
    .replace(/\n+/g, ' ') // Replace line breaks with spaces
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  return cleaned;
}

// Helper function to intelligently chunk text for TTS
function chunkTextForTTS(text: string, maxLength: number = 800): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = '';
  
  // Split by sentences first
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim() + (i < sentences.length - 1 ? '.' : '');
    
    // If adding this sentence would exceed the limit, finalize current chunk
    if (currentChunk.length + sentence.length > maxLength && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += (currentChunk.length > 0 ? ' ' : '') + sentence;
    }
  }
  
  // Add the final chunk if it has content
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }
  
  // If we still have chunks that are too long, split them more aggressively
  const finalChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLength) {
      finalChunks.push(chunk);
    } else {
      // Split by words if sentence-based splitting wasn't enough
      const words = chunk.split(' ');
      let wordChunk = '';
      
      for (const word of words) {
        if (wordChunk.length + word.length + 1 > maxLength && wordChunk.length > 0) {
          finalChunks.push(wordChunk.trim());
          wordChunk = word;
        } else {
          wordChunk += (wordChunk.length > 0 ? ' ' : '') + word;
        }
      }
      
      if (wordChunk.trim().length > 0) {
        finalChunks.push(wordChunk.trim());
      }
    }
  }
  
  return finalChunks.length > 0 ? finalChunks : [text.substring(0, maxLength)];
}

// Optimized chat history retrieval with caching
const historyCache = new Map<string, { data: ChatHistory; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Cleanup function for memory management (called during requests)
function cleanupCache() {
  const now = Date.now();
  for (const [key, value] of historyCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      historyCache.delete(key);
    }
  }
}

async function getChatHistoryOptimized(kv: KVNamespace | undefined, sessionId: string): Promise<ChatHistory> {
  // Perform cache cleanup periodically (during request processing)
  if (Math.random() < 0.1) { // 10% chance to clean on each request
    cleanupCache();
  }

  // Check cache first
  const cacheKey = `chat_${sessionId}`;
  const cached = historyCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }

  // Default empty history
  const defaultHistory: ChatHistory = {
    sessionId,
    messages: [],
    createdAt: Date.now(),
    lastUpdated: Date.now()
  };

  if (!kv) {
    return defaultHistory;
  }

  try {
    const historyData = await kv.get(cacheKey);
    if (historyData) {
      const parsedHistory = JSON.parse(historyData) as ChatHistory;
      // Update cache
      historyCache.set(cacheKey, { data: parsedHistory, timestamp: Date.now() });
      return parsedHistory;
    }
  } catch (error) {
    console.error('Error retrieving chat history:', error);
  }

  // Cache empty history
  historyCache.set(cacheKey, { data: defaultHistory, timestamp: Date.now() });
  return defaultHistory;
}

// Optimized chat history saving with batching
const saveQueue = new Map<string, { history: ChatHistory; timeout: number }>();

async function saveChatHistoryOptimized(kv: KVNamespace | undefined, history: ChatHistory): Promise<void> {
  if (!kv) return;

  const cacheKey = `chat_${history.sessionId}`;
  
  // Clear existing timeout if any
  const existing = saveQueue.get(cacheKey);
  if (existing) {
    clearTimeout(existing.timeout);
  }

  // Update cache immediately
  historyCache.set(cacheKey, { data: history, timestamp: Date.now() });

  // Batch save with debounce
  const timeout = setTimeout(async () => {
    try {
      history.lastUpdated = Date.now();
      await kv.put(cacheKey, JSON.stringify(history), {
        expirationTtl: 7 * 24 * 60 * 60 // 7 days
      });
      saveQueue.delete(cacheKey);
    } catch (error) {
      console.error('Error saving chat history:', error);
    }
  }, 1000); // 1 second debounce

  saveQueue.set(cacheKey, { history, timeout });
}

// Handle chat API with optimized async processing
app.post('/api/chat', async (c) => {
  try {
    const { message, audioData, sessionId, tts = false, voice = 'Kore' } = await c.req.json() as { 
      message?: string; 
      audioData?: string; 
      sessionId?: string;
      tts?: boolean;
      voice?: string;
    };
    
    if (!message && !audioData) {
      return c.text('Message or audio data is required', 400);
    }

    // Generate or use provided session ID
    const currentSessionId = sessionId || generateSessionId();
    
    // Initialize AI client early
    const ai = new GoogleGenAI({ apiKey: c.env.GEMINI_API_KEY });

    // Create a readable stream for Server-Sent Events
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Start chat history retrieval in parallel
    const chatHistoryPromise = getChatHistoryOptimized(c.env.CHAT_HISTORY, currentSessionId);

    // Process the request asynchronously
    (async () => {
      let assistantResponse = '';
      
      try {
        // Wait for chat history (should be fast due to caching)
        const chatHistory = await chatHistoryPromise;
        
        // Build conversation with history
        const conversationHistory = buildConversationHistory(chatHistory);
        
        // Handle audio or text message
        if (audioData) {
          // Audio transcription in parallel
          const transcriptionHistory = [...conversationHistory];
          transcriptionHistory.push({
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/webm',
                  data: audioData
                }
              },
              {
                text: 'Please transcribe this audio message and return only the transcribed text without any additional commentary.'
              }
            ]
          });
          
          // Get transcription
          const transcriptionResponse = await ai.models.generateContent({
            model: 'gemini-2.5-pro-preview-05-06',
            contents: transcriptionHistory,
            config: {
              tools: [{ googleSearch: {} }]
            }
          });
          
          const transcribedText = transcriptionResponse.text || '';
          
          conversationHistory.push({
            role: 'user',
            parts: [{ text: `[Voice message transcription]: ${transcribedText}` }]
          });
        } else {
          // Text message
          conversationHistory.push({
            role: 'user',
            parts: [{ text: message! }]
          });
        }

        // Configure tools
        const tools = [
          { codeExecution: {} },
          { googleSearch: {} }
        ];

        // Start main AI response stream
        const response = await ai.models.generateContentStream({
          model: 'gemini-2.5-pro-preview-05-06',
          contents: conversationHistory,
          config: {
            tools: tools,
            thinkingConfig: {
              includeThoughts: true
            }
          }
        });

        // Process streaming response
        for await (const chunk of response) {
          if (chunk.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if (part.thought) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'thinking',
                  content: part.text || ''
                })}\n\n`));
              } else if (part.executableCode) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'code',
                  content: part.executableCode.code || '',
                  language: part.executableCode.language || 'python'
                })}\n\n`));
              } else if (part.codeExecutionResult) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'codeResult',
                  content: part.codeExecutionResult.output || ''
                })}\n\n`));
              } else if (part.text) {
                assistantResponse += part.text;
                
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'text',
                  content: part.text
                })}\n\n`));
              }
            }
          }

          // Handle grounding metadata (search results)
          if (chunk.candidates?.[0]?.groundingMetadata) {
            const metadata = chunk.candidates[0].groundingMetadata;
            if (metadata.webSearchQueries?.length) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({
                type: 'search',
                content: `Searched: ${metadata.webSearchQueries.join(', ')}`
              })}\n\n`));
            }
          }
        }

        // Handle TTS after text completion
        if (tts && assistantResponse.trim()) {
          try {
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: 'ttsLoading',
              content: 'Generating speech...'
            })}\n\n`));

            // Clean and chunk the text for TTS
            const cleanedText = cleanTextForTTS(assistantResponse);
            const textChunks = chunkTextForTTS(cleanedText, 750); // Slightly smaller chunks for safety
            
            console.log(`Generating TTS for ${textChunks.length} chunks, total length: ${cleanedText.length}`);
            
            if (textChunks.length > 0) {
              // Send chunk info to frontend
              await writer.write(encoder.encode(`data: ${JSON.stringify({
                type: 'ttsChunkInfo',
                totalChunks: textChunks.length,
                totalLength: cleanedText.length
              })}\n\n`));

              // Generate TTS for each chunk
              for (let i = 0; i < textChunks.length; i++) {
                try {
                  const chunkText = textChunks[i];
                  
                  const ttsResponse = await ai.models.generateContent({
                    model: 'gemini-2.5-flash-preview-tts',
                    contents: [{ parts: [{ text: chunkText }] }],
                    config: {
                      responseModalities: ['AUDIO'],
                      speechConfig: {
                        voiceConfig: {
                          prebuiltVoiceConfig: { voiceName: voice }
                        }
                      }
                    }
                  });

                  const audioData = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                  
                  if (audioData) {
                    await writer.write(encoder.encode(`data: ${JSON.stringify({
                      type: 'audioChunk',
                      audioData: audioData,
                      chunkIndex: i,
                      totalChunks: textChunks.length,
                      isLastChunk: i === textChunks.length - 1
                    })}\n\n`));
                  } else {
                    console.error(`Failed to generate audio for chunk ${i + 1}/${textChunks.length}`);
                  }
                } catch (chunkError) {
                  console.error(`Error generating TTS for chunk ${i + 1}:`, chunkError);
                  // Continue with next chunk even if one fails
                }
              }
            }
          } catch (ttsError) {
            console.error('TTS generation error:', ttsError);
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: 'ttsError',
              content: 'Speech generation failed'
            })}\n\n`));
          }
        }

        // Send completion signal
        await writer.write(encoder.encode(`data: ${JSON.stringify({
          type: 'complete'
        })}\n\n`));

      } catch (error) {
        console.error('Error in chat processing:', error);
        await writer.write(encoder.encode(`data: ${JSON.stringify({
          type: 'error',
          content: 'An error occurred while processing your request.'
        })}\n\n`));
      } finally {
        // Save chat history asynchronously (non-blocking)
        if (assistantResponse.trim()) {
          const chatHistory = await chatHistoryPromise;
          chatHistory.messages.push(
            {
              role: 'user',
              content: audioData ? '🎤 Voice message' : message!,
              timestamp: Date.now()
            },
            {
              role: 'model',
              content: assistantResponse.trim(),
              timestamp: Date.now()
            }
          );
          
          // Keep only last 20 messages to prevent history from growing too large
          if (chatHistory.messages.length > 20) {
            chatHistory.messages = chatHistory.messages.slice(-20);
          }
          
          // Save asynchronously without blocking
          saveChatHistoryOptimized(c.env.CHAT_HISTORY, chatHistory);
        }
        
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error('Error handling chat request:', error);
    return c.text('Internal Server Error', 500);
  }
});

// Helper functions for chat history management
function generateSessionId(): string {
  return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function buildConversationHistory(chatHistory: ChatHistory): Array<{ role: 'user' | 'model'; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> {
  const conversation = [];
  
  // Add system prompt
  conversation.push({
    role: 'user' as const,
    parts: [{ text: SYSTEM_PROMPT }]
  });
  
  conversation.push({
    role: 'model' as const,
    parts: [{ text: 'I understand. I will follow these guidelines to provide exceptional, thoughtful responses using my thinking, code execution, and web search capabilities as appropriate.' }]
  });

  // Add chat history if available (optimized to only include recent relevant context)
  if (chatHistory.messages.length > 0) {
    // Only include last 10 messages for context to reduce token usage
    const recentMessages = chatHistory.messages.slice(-10);
    const historyContext = `Previous conversation context:\n${recentMessages.map(msg => `${msg.role}: ${msg.content.substring(0, 150)}${msg.content.length > 150 ? '...' : ''}`).join('\n')}`;
    
    conversation.push({
      role: 'user' as const,
      parts: [{ text: historyContext }]
    });
    
    conversation.push({
      role: 'model' as const,
      parts: [{ text: 'I understand the previous conversation context and will build upon it in my responses.' }]
    });
  }

  return conversation;
}

export default app;