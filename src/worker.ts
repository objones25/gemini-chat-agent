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

  // Limit length for TTS
  const maxLength = 800;
  if (cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength) + '...';
  }

  return cleaned;
}

// Handle chat API
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
    
    // Get chat history from KV storage
    const chatHistory = await getChatHistory(c.env.CHAT_HISTORY, currentSessionId);

    const ai = new GoogleGenAI({ apiKey: c.env.GEMINI_API_KEY });

    // Create a readable stream for Server-Sent Events
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Process the request asynchronously
    (async () => {
      let assistantResponse = '';
      
      try {
        // Build conversation with history
        const conversationHistory = buildConversationHistory(chatHistory);
        
        // Handle audio or text message
        let transcribedText = '';
        
        if (audioData) {
          // First, transcribe the audio without code execution
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
          
          // Get transcription without code execution tools
          const transcriptionResponse = await ai.models.generateContent({
            model: 'gemini-2.5-pro-preview-05-06',
            contents: transcriptionHistory,
            config: {
              tools: [{ googleSearch: {} }] // Only search, no code execution
            }
          });
          
          transcribedText = transcriptionResponse.text || '';
          
          // Now add the transcribed text as a regular text message
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

        // Always enable all tools for the main response
        const tools = [
          { codeExecution: {} },
          { googleSearch: {} }
        ];

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

        for await (const chunk of response) {
          // Handle different types of content
          if (chunk.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if (part.thought) {
                // Send thinking content
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'thinking',
                  content: part.text || ''
                })}\n\n`));
              } else if (part.executableCode) {
                // Send code content
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'code',
                  content: part.executableCode.code || '',
                  language: part.executableCode.language || 'python'
                })}\n\n`));
              } else if (part.codeExecutionResult) {
                // Send code execution result
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'codeResult',
                  content: part.codeExecutionResult.output || ''
                })}\n\n`));
              } else if (part.text) {
                // Collect assistant response for history
                assistantResponse += part.text;
                
                // Send regular text content
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

        // Generate TTS if requested and we have text content
        if (tts && assistantResponse.trim()) {
          try {
            // Send TTS loading indicator
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: 'ttsLoading',
              content: 'Generating speech...'
            })}\n\n`));

            // Clean the text for TTS
            const cleanText = cleanTextForTTS(assistantResponse);
            
            if (cleanText.length > 0) {
              // Generate TTS
              const ttsResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash-preview-tts',
                contents: [{ parts: [{ text: cleanText }] }],
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
                // Send audio data
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'audio',
                  audioData: audioData
                })}\n\n`));
              } else {
                // Send TTS error
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'ttsError',
                  content: 'Failed to generate speech'
                })}\n\n`));
              }
            }
          } catch (ttsError) {
            console.error('TTS generation error:', ttsError);
            // Send TTS error
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
        // Save chat history
        if (assistantResponse.trim()) {
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
          
          await saveChatHistory(c.env.CHAT_HISTORY, chatHistory);
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

async function getChatHistory(kv: KVNamespace | undefined, sessionId: string): Promise<ChatHistory> {
  if (!kv) {
    // Return empty history if KV is not available
    return {
      sessionId,
      messages: [],
      createdAt: Date.now(),
      lastUpdated: Date.now()
    };
  }

  try {
    const historyData = await kv.get(`chat_${sessionId}`);
    if (historyData) {
      return JSON.parse(historyData) as ChatHistory;
    }
  } catch (error) {
    console.error('Error retrieving chat history:', error);
  }

  // Return empty history if not found or error
  return {
    sessionId,
    messages: [],
    createdAt: Date.now(),
    lastUpdated: Date.now()
  };
}

async function saveChatHistory(kv: KVNamespace | undefined, history: ChatHistory): Promise<void> {
  if (!kv) return;

  try {
    history.lastUpdated = Date.now();
    await kv.put(`chat_${history.sessionId}`, JSON.stringify(history), {
      expirationTtl: 7 * 24 * 60 * 60 // 7 days
    });
  } catch (error) {
    console.error('Error saving chat history:', error);
  }
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

  // Add chat history if available
  if (chatHistory.messages.length > 0) {
    // Add a context message about previous conversation
    const historyContext = `Previous conversation context:\n${chatHistory.messages.map(msg => `${msg.role}: ${msg.content.substring(0, 200)}${msg.content.length > 200 ? '...' : ''}`).join('\n')}`;
    
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