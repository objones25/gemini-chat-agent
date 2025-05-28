import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI } from '@google/genai';
import { SYSTEM_PROMPT } from './systemPrompt';

interface Env {
  GEMINI_API_KEY: string;
  CHAT_HISTORY?: KVNamespace;
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

// Serve static files
app.get('/', (c) => {
  return c.html(getIndexHTML());
});

app.get('/index.html', (c) => {
  return c.html(getIndexHTML());
});

app.get('/style.css', (c) => {
  return c.text(getStyleCSS(), 200, {
    'Content-Type': 'text/css',
  });
});

app.get('/script.js', (c) => {
  return c.text(getScriptJS(), 200, {
    'Content-Type': 'application/javascript',
  });
});

// Handle chat API
app.post('/api/chat', async (c) => {
  try {
    const { message, sessionId } = await c.req.json() as { message: string; sessionId?: string };
    
    if (!message) {
      return c.text('Message is required', 400);
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
        conversationHistory.push({
          role: 'user',
          parts: [{ text: message }]
        });

        const response = await ai.models.generateContentStream({
          model: 'gemini-2.5-pro-preview-05-06',
          contents: conversationHistory,
          config: {
            tools: [
              { codeExecution: {} },
              { googleSearch: {} }
            ],
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
              content: message,
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

function getIndexHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Chat Agent</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>🤖 Gemini Chat Agent</h1>
            <p>Powered by Gemini 2.5 Pro with Code Execution, Thinking & Google Search</p>
        </header>
        
        <div class="chat-container">
            <div id="messages" class="messages"></div>
            
            <div class="input-container">
                <textarea 
                    id="messageInput" 
                    placeholder="Ask me anything... I can think, search, and execute code!"
                    rows="3"
                ></textarea>
                <button id="sendButton">Send</button>
            </div>
        </div>
    </div>
    
    <script src="/script.js"></script>
</body>
</html>`;
}

function getStyleCSS(): string {
  return `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0a0a0a;
    min-height: 100vh;
    padding: 16px;
    color: #ffffff;
}

.container {
    max-width: 900px;
    margin: 0 auto;
    background: rgba(18, 18, 18, 0.95);
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(20px);
    box-shadow: 0 32px 64px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
}

header {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #ec4899 100%);
    color: white;
    padding: 24px;
    text-align: center;
    position: relative;
    overflow: hidden;
}

header::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
    animation: shimmer 3s infinite;
}

@keyframes shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
}

header h1 {
    font-size: 2rem;
    font-weight: 700;
    margin-bottom: 8px;
    position: relative;
    z-index: 1;
}

header p {
    opacity: 0.9;
    font-size: 0.95rem;
    font-weight: 400;
    position: relative;
    z-index: 1;
}

.chat-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    height: 100%;
}

.messages {
    flex: 1;
    padding: 24px;
    overflow-y: auto;
    background: transparent;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}

.messages::-webkit-scrollbar {
    width: 6px;
}

.messages::-webkit-scrollbar-track {
    background: transparent;
}

.messages::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
}

.message {
    margin-bottom: 24px;
    animation: slideIn 0.4s ease-out;
}

@keyframes slideIn {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
}

.message.user {
    text-align: right;
}

.message.assistant {
    text-align: left;
}

.message-content {
    display: inline-block;
    max-width: 85%;
    padding: 16px 20px;
    border-radius: 20px;
    word-wrap: break-word;
    position: relative;
}

.message.user .message-content {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    color: white;
    box-shadow: 0 8px 32px rgba(99, 102, 241, 0.3);
}

.message.assistant .message-content {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    color: #e5e7eb;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.thinking-section {
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 12px;
    padding: 16px;
    margin: 12px 0;
    font-size: 0.9rem;
    backdrop-filter: blur(10px);
}

.thinking-header {
    font-weight: 600;
    color: #fbbf24;
    margin-bottom: 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: all 0.2s ease;
}

.thinking-header:hover {
    color: #f59e0b;
}

.thinking-content {
    color: #fde68a;
    white-space: pre-wrap;
    line-height: 1.5;
}

.code-section {
    background: rgba(15, 23, 42, 0.8);
    color: #e2e8f0;
    border-radius: 12px;
    padding: 16px;
    margin: 12px 0;
    font-family: 'JetBrains Mono', 'Fira Code', 'Monaco', 'Menlo', monospace;
    font-size: 0.9rem;
    overflow-x: auto;
    border: 1px solid rgba(148, 163, 184, 0.2);
    backdrop-filter: blur(10px);
}

.code-header {
    color: #94a3b8;
    font-size: 0.8rem;
    margin-bottom: 12px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
}

.search-section {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 12px;
    padding: 16px;
    margin: 12px 0;
    backdrop-filter: blur(10px);
}

.search-header {
    font-weight: 600;
    color: #60a5fa;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.search-sources {
    font-size: 0.9rem;
    color: #93c5fd;
    line-height: 1.5;
}

.input-container {
    padding: 24px;
    background: rgba(255, 255, 255, 0.02);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    gap: 16px;
    align-items: flex-end;
    backdrop-filter: blur(10px);
}

#messageInput {
    flex: 1;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 16px;
    padding: 16px 20px;
    font-size: 1rem;
    resize: none;
    font-family: inherit;
    outline: none;
    background: rgba(255, 255, 255, 0.05);
    color: #ffffff;
    transition: all 0.3s ease;
    backdrop-filter: blur(10px);
}

#messageInput::placeholder {
    color: rgba(255, 255, 255, 0.5);
}

#messageInput:focus {
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    background: rgba(255, 255, 255, 0.08);
}

#sendButton {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    color: white;
    border: none;
    border-radius: 16px;
    padding: 16px 28px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    box-shadow: 0 8px 32px rgba(99, 102, 241, 0.3);
    position: relative;
    overflow: hidden;
}

#sendButton::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
    transition: left 0.5s;
}

#sendButton:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 12px 40px rgba(99, 102, 241, 0.4);
}

#sendButton:hover:not(:disabled)::before {
    left: 100%;
}

#sendButton:active:not(:disabled) {
    transform: translateY(0);
}

#sendButton:disabled {
    background: rgba(156, 163, 175, 0.3);
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
}

.loading {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top: 2px solid #6366f1;
    border-radius: 50%;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.collapsed .thinking-content {
    display: none;
}

.toggle-icon {
    transition: transform 0.3s ease;
    font-size: 0.8rem;
}

.collapsed .toggle-icon {
    transform: rotate(-90deg);
}

/* Responsive design */
@media (max-width: 768px) {
    body {
        padding: 8px;
    }
    
    .container {
        height: calc(100vh - 16px);
        border-radius: 16px;
    }
    
    header {
        padding: 20px 16px;
    }
    
    header h1 {
        font-size: 1.6rem;
    }
    
    .messages {
        padding: 16px;
    }
    
    .input-container {
        padding: 16px;
        gap: 12px;
    }
    
    #messageInput {
        padding: 14px 16px;
    }
    
    #sendButton {
        padding: 14px 20px;
    }
}`;
}

function getScriptJS(): string {
  return `class ChatApp {
    constructor() {
        this.messagesContainer = document.getElementById('messages');
        this.messageInput = document.getElementById('messageInput');
        this.sendButton = document.getElementById('sendButton');
        this.sessionId = this.getOrCreateSessionId();
        
        this.setupEventListeners();
    }
    
    getOrCreateSessionId() {
        let sessionId = localStorage.getItem('gemini-chat-session');
        if (!sessionId) {
            sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('gemini-chat-session', sessionId);
        }
        return sessionId;
    }
    
    setupEventListeners() {
        this.sendButton.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
    }
    
    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message) return;
        
        // Add user message
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.sendButton.disabled = true;
        
        // Add loading message
        const loadingMessage = this.addMessage('assistant', '');
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading';
        loadingMessage.querySelector('.message-content').appendChild(loadingDiv);
        
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message, sessionId: this.sessionId }),
            });
            
            if (!response.ok) {
                throw new Error('Failed to get response');
            }
            
            // Remove loading message
            loadingMessage.remove();
            
            // Create new message for streaming response
            const assistantMessage = this.addMessage('assistant', '');
            const messageContent = assistantMessage.querySelector('.message-content');
            
            // Handle streaming response
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\\n');
                buffer = lines.pop(); // Keep incomplete line in buffer
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            this.handleStreamData(data, messageContent);
                        } catch (e) {
                            console.error('Error parsing stream data:', e);
                        }
                    }
                }
            }
            
        } catch (error) {
            console.error('Error:', error);
            loadingMessage.querySelector('.message-content').innerHTML = 
                '<span style="color: red;">Error: Failed to get response</span>';
        } finally {
            this.sendButton.disabled = false;
            this.messageInput.focus();
        }
    }
    
    handleStreamData(data, messageContent) {
        switch (data.type) {
            case 'thinking':
                this.addThinkingSection(messageContent, data.content);
                break;
            case 'code':
                this.addCodeSection(messageContent, data.content, data.language);
                break;
            case 'codeResult':
                this.addCodeResultSection(messageContent, data.content);
                break;
            case 'search':
                this.addSearchSection(messageContent, data.content);
                break;
            case 'text':
                this.addTextContent(messageContent, data.content);
                break;
            case 'complete':
                // Response complete
                break;
        }
        
        // Auto-scroll to bottom
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
    
    addMessage(role, content) {
        const messageDiv = document.createElement('div');
        messageDiv.className = \`message \${role}\`;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.textContent = content;
        
        messageDiv.appendChild(contentDiv);
        this.messagesContainer.appendChild(messageDiv);
        
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        
        return messageDiv;
    }
    
    addThinkingSection(messageContent, content) {
        const thinkingDiv = document.createElement('div');
        thinkingDiv.className = 'thinking-section';
        
        const header = document.createElement('div');
        header.className = 'thinking-header';
        header.innerHTML = '<span class="toggle-icon">▼</span> 🤔 Thinking...';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'thinking-content';
        contentDiv.textContent = content;
        
        header.addEventListener('click', () => {
            thinkingDiv.classList.toggle('collapsed');
        });
        
        thinkingDiv.appendChild(header);
        thinkingDiv.appendChild(contentDiv);
        messageContent.appendChild(thinkingDiv);
    }
    
    addCodeSection(messageContent, content, language = 'python') {
        const codeDiv = document.createElement('div');
        codeDiv.className = 'code-section';
        
        const header = document.createElement('div');
        header.className = 'code-header';
        header.textContent = \`💻 Code (\${language})\`;
        
        const codeContent = document.createElement('pre');
        codeContent.textContent = content;
        
        codeDiv.appendChild(header);
        codeDiv.appendChild(codeContent);
        messageContent.appendChild(codeDiv);
    }
    
    addCodeResultSection(messageContent, content) {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'code-section';
        resultDiv.style.background = '#065f46';
        
        const header = document.createElement('div');
        header.className = 'code-header';
        header.textContent = '📊 Code Output';
        
        const resultContent = document.createElement('pre');
        resultContent.textContent = content;
        
        resultDiv.appendChild(header);
        resultDiv.appendChild(resultContent);
        messageContent.appendChild(resultDiv);
    }
    
    addSearchSection(messageContent, content) {
        const searchDiv = document.createElement('div');
        searchDiv.className = 'search-section';
        
        const header = document.createElement('div');
        header.className = 'search-header';
        header.textContent = '🔍 Google Search';
        
        const sourcesDiv = document.createElement('div');
        sourcesDiv.className = 'search-sources';
        sourcesDiv.textContent = content;
        
        searchDiv.appendChild(header);
        searchDiv.appendChild(sourcesDiv);
        messageContent.appendChild(searchDiv);
    }
    
    addTextContent(messageContent, content) {
        const textDiv = document.createElement('div');
        textDiv.style.marginTop = '10px';
        textDiv.textContent = content;
        messageContent.appendChild(textDiv);
    }
}

// Initialize the chat app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new ChatApp();
});`;
}

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

function buildConversationHistory(chatHistory: ChatHistory): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
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
