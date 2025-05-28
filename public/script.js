class ChatApp {
    constructor() {
        this.messagesContainer = document.getElementById('messages');
        this.messageInput = document.getElementById('messageInput');
        this.sendButton = document.getElementById('sendButton');
        this.recordButton = document.getElementById('recordButton');
        this.sessionId = this.getOrCreateSessionId();
        
        // Voice recording properties
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isRecording = false;
        this.stream = null;
        
        this.setupEventListeners();
    }
    
    // Simple markdown parser for basic formatting
    parseMarkdown(text) {
        if (!text) return '';
        
        // Escape HTML to prevent XSS, but we'll selectively allow our markdown
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        
        // Parse markdown elements (order matters!)
        
        // Headers
        html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
        
        // Bold and italic (handle ** before * to avoid conflicts)
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // Inline code (before other formatting)
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Lists (simple implementation)
        html = html.replace(/^[\*\-\+] (.*)$/gm, '<li>$1</li>');
        
        // Wrap consecutive <li> elements in <ul>
        html = html.replace(/(<li>.*<\/li>)/gs, function(match) {
            if (match.includes('</ul>')) return match; // Already wrapped
            return '<ul>' + match + '</ul>';
        });
        
        // Fix multiple consecutive ul tags
        html = html.replace(/<\/ul>\s*<ul>/g, '');
        
        // Line breaks and paragraphs
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');
        
        // Wrap in paragraph tags if there's content
        if (html.trim() && !html.startsWith('<h') && !html.startsWith('<ul') && !html.startsWith('<p>')) {
            html = '<p>' + html + '</p>';
        }
        
        // Clean up empty paragraphs
        html = html.replace(/<p><\/p>/g, '');
        html = html.replace(/<p>\s*<\/p>/g, '');
        
        return html;
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
        
        // Voice recording event listeners
        this.recordButton.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.startRecording();
        });
        
        this.recordButton.addEventListener('mouseup', (e) => {
            e.preventDefault();
            this.stopRecording();
        });
        
        this.recordButton.addEventListener('mouseleave', (e) => {
            if (this.isRecording) {
                this.stopRecording();
            }
        });
        
        // Touch events for mobile
        this.recordButton.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.startRecording();
        });
        
        this.recordButton.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.stopRecording();
        });
        
        this.recordButton.addEventListener('touchcancel', (e) => {
            if (this.isRecording) {
                this.stopRecording();
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
                const lines = buffer.split('\n');
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
        messageDiv.className = 'message ' + role;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        
        if (role === 'user') {
            contentDiv.textContent = content; // User messages stay as plain text
        } else {
            contentDiv.innerHTML = this.parseMarkdown(content); // Assistant messages get markdown parsing
        }
        
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
        contentDiv.innerHTML = this.parseMarkdown(content); // Parse markdown in thinking content too
        
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
        header.textContent = '💻 Code (' + language + ')';
        
        const codeContent = document.createElement('pre');
        codeContent.innerHTML = `<code class="language-${language}">${this.escapeHtml(content)}</code>`;
        
        codeDiv.appendChild(header);
        codeDiv.appendChild(codeContent);
        messageContent.appendChild(codeDiv);
    }
    
    addCodeResultSection(messageContent, content) {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'code-section result';
        
        const header = document.createElement('div');
        header.className = 'code-header';
        header.textContent = '📊 Code Output';
        
        const resultContent = document.createElement('pre');
        resultContent.innerHTML = `<code>${this.escapeHtml(content)}</code>`;
        
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
        sourcesDiv.innerHTML = this.parseMarkdown(content);
        
        searchDiv.appendChild(header);
        searchDiv.appendChild(sourcesDiv);
        messageContent.appendChild(searchDiv);
    }
    
    addTextContent(messageContent, content) {
        const textDiv = document.createElement('div');
        textDiv.className = 'markdown-content';
        textDiv.innerHTML = this.parseMarkdown(content); // This is the key change!
        messageContent.appendChild(textDiv);
    }
    
    // Helper function to escape HTML
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    async startRecording() {
        if (this.isRecording) return;
        
        try {
            // Request microphone access
            this.stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            
            // Create MediaRecorder with preferred format
            let mimeType = 'audio/webm;codecs=opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'audio/webm';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = 'audio/mp4';
                    if (!MediaRecorder.isTypeSupported(mimeType)) {
                        mimeType = ''; // Use default
                    }
                }
            }
            
            this.mediaRecorder = new MediaRecorder(this.stream, {
                mimeType: mimeType || undefined
            });
            
            this.audioChunks = [];
            
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };
            
            this.mediaRecorder.onstop = () => {
                this.processRecording();
            };
            
            this.mediaRecorder.onerror = (event) => {
                console.error('MediaRecorder error:', event.error);
                this.resetRecording();
            };
            
            // Start recording
            this.mediaRecorder.start(100); // Collect data every 100ms
            this.isRecording = true;
            
            // Update UI
            this.recordButton.classList.add('recording');
            this.recordButton.querySelector('.record-text').textContent = 'Recording...';
            this.recordButton.querySelector('.record-icon').textContent = '⏹️';
            this.recordButton.disabled = false;
            
            console.log('Recording started');
            
        } catch (error) {
            console.error('Error starting recording:', error);
            this.handleRecordingError(error);
        }
    }
    
    stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;
        
        try {
            this.mediaRecorder.stop();
            this.isRecording = false;
            
            // Stop all tracks
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
                this.stream = null;
            }
            
            // Update UI
            this.recordButton.classList.remove('recording');
            this.recordButton.querySelector('.record-text').textContent = 'Processing...';
            this.recordButton.querySelector('.record-icon').textContent = '🎤';
            this.recordButton.disabled = true;
            
            console.log('Recording stopped');
            
        } catch (error) {
            console.error('Error stopping recording:', error);
            this.resetRecording();
        }
    }
    
    async processRecording() {
        try {
            if (this.audioChunks.length === 0) {
                throw new Error('No audio data captured');
            }
            
            // Create blob from chunks
            const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
            const audioBlob = new Blob(this.audioChunks, { type: mimeType });
            
            console.log('Audio blob created:', {
                size: audioBlob.size,
                type: audioBlob.type
            });
            
            // Check size limit (20MB for Gemini API)
            if (audioBlob.size > 20 * 1024 * 1024) {
                throw new Error('Audio file too large (max 20MB)');
            }
            
            if (audioBlob.size < 1000) {
                throw new Error('Audio recording too short');
            }
            
            // Convert to base64
            const base64Audio = await this.blobToBase64(audioBlob);
            
            // Send audio message
            await this.sendAudioMessage(base64Audio, mimeType);
            
        } catch (error) {
            console.error('Error processing recording:', error);
            this.handleRecordingError(error);
        } finally {
            this.resetRecording();
        }
    }
    
    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                try {
                    const base64String = reader.result.split(',')[1]; // Remove data URL prefix
                    resolve(base64String);
                } catch (error) {
                    reject(error);
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }
    
    async sendAudioMessage(audioData, mimeType) {
        // Add user message indicator
        this.addMessage('user', '🎤 Voice message');
        
        // Disable send button
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
                body: JSON.stringify({ 
                    audioData, 
                    sessionId: this.sessionId 
                }),
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
                const lines = buffer.split('\n');
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
            console.error('Error sending audio:', error);
            loadingMessage.querySelector('.message-content').innerHTML = 
                '<span style="color: red;">Error: Failed to process voice message</span>';
        } finally {
            this.sendButton.disabled = false;
            this.messageInput.focus();
        }
    }
    
    handleRecordingError(error) {
        let errorMessage = 'Recording failed';
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            errorMessage = 'Microphone permission denied. Please allow microphone access and try again.';
        } else if (error.name === 'NotFoundError') {
            errorMessage = 'No microphone found. Please connect a microphone and try again.';
        } else if (error.name === 'NotReadableError') {
            errorMessage = 'Microphone is being used by another application.';
        } else if (error.message) {
            errorMessage = error.message;
        }
        
        // Show error message
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #ef4444; color: white; padding: 12px 16px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; max-width: 300px; font-size: 14px;';
        errorDiv.textContent = errorMessage;
        document.body.appendChild(errorDiv);
        
        // Remove error message after 5 seconds
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.parentNode.removeChild(errorDiv);
            }
        }, 5000);
    }
    
    resetRecording() {
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        // Reset UI
        this.recordButton.classList.remove('recording');
        this.recordButton.querySelector('.record-text').textContent = 'Hold to Record';
        this.recordButton.querySelector('.record-icon').textContent = '🎤';
        this.recordButton.disabled = false;
    }
}

// Initialize the chat app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new ChatApp();
});