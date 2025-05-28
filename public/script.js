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
        
        // TTS properties
        this.ttsEnabled = localStorage.getItem('tts-enabled') === 'true';
        this.audioContext = null;
        this.currentAudioSource = null;
        
        // Performance optimizations
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.scrollThrottled = this.throttle(this.scrollToBottom.bind(this), 100);
        
        this.setupEventListeners();
        this.createTTSToggle();
        this.initializeAudioContext();
    }
    
    // Throttle function for performance
    throttle(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        }
    }
    
    // Optimized scroll to bottom
    scrollToBottom() {
        if (this.messagesContainer) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
    }
    
    // Initialize Web Audio API context
    async initializeAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (error) {
            console.warn('Web Audio API not supported:', error);
        }
    }
    
    // Create TTS toggle button
    createTTSToggle() {
        const buttonGroup = document.querySelector('.button-group');
        
        const ttsButton = document.createElement('button');
        ttsButton.id = 'ttsButton';
        ttsButton.className = 'tts-button';
        ttsButton.title = 'Toggle text-to-speech';
        ttsButton.innerHTML = `
            <span class="tts-icon">🔊</span>
            <span class="tts-text">TTS</span>
        `;
        
        // Set initial state
        if (this.ttsEnabled) {
            ttsButton.classList.add('enabled');
        }
        
        ttsButton.addEventListener('click', () => {
            this.toggleTTS();
        });
        
        // Insert before record button
        buttonGroup.insertBefore(ttsButton, this.recordButton);
    }
    
    // Toggle TTS functionality
    toggleTTS() {
        this.ttsEnabled = !this.ttsEnabled;
        localStorage.setItem('tts-enabled', this.ttsEnabled.toString());
        
        const ttsButton = document.getElementById('ttsButton');
        if (this.ttsEnabled) {
            ttsButton.classList.add('enabled');
            ttsButton.title = 'Text-to-speech enabled';
        } else {
            ttsButton.classList.remove('enabled');
            ttsButton.title = 'Text-to-speech disabled';
            
            // Stop any currently playing audio
            this.stopAudio();
        }
    }
    
    // Stop currently playing audio
    stopAudio() {
        if (this.currentAudioSource) {
            try {
                this.currentAudioSource.stop();
            } catch (error) {
                // Audio source might already be stopped
            }
            this.currentAudioSource = null;
        }
    }
    
    // Optimized audio playback with Web Workers for processing
    async playAudio(base64AudioData) {
        if (!this.audioContext || !this.ttsEnabled) {
            return;
        }
        
        try {
            // Stop any currently playing audio
            this.stopAudio();
            
            // Resume audio context if suspended
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            // Use requestAnimationFrame for smooth audio processing
            requestAnimationFrame(async () => {
                try {
                    // Convert base64 to ArrayBuffer
                    const binaryString = atob(base64AudioData);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    
                    // The TTS API returns 16-bit PCM at 24kHz, mono
                    const sampleRate = 24000;
                    const channels = 1;
                    const bytesPerSample = 2;
                    
                    // Convert PCM data to AudioBuffer
                    const numSamples = bytes.length / bytesPerSample;
                    const audioBuffer = this.audioContext.createBuffer(channels, numSamples, sampleRate);
                    const channelData = audioBuffer.getChannelData(0);
                    
                    // Convert 16-bit PCM to float32 (optimized)
                    const dataView = new DataView(bytes.buffer);
                    for (let i = 0; i < numSamples; i++) {
                        const sample = dataView.getInt16(i * 2, true); // little endian
                        channelData[i] = sample / 32768; // Convert to [-1, 1] range
                    }
                    
                    // Create audio source and play
                    this.currentAudioSource = this.audioContext.createBufferSource();
                    this.currentAudioSource.buffer = audioBuffer;
                    this.currentAudioSource.connect(this.audioContext.destination);
                    
                    // Handle audio end
                    this.currentAudioSource.onended = () => {
                        this.currentAudioSource = null;
                    };
                    
                    this.currentAudioSource.start();
                } catch (error) {
                    console.error('Error in audio processing:', error);
                    this.showError('Failed to play audio');
                }
            });
            
        } catch (error) {
            console.error('Error playing audio:', error);
            this.showError('Failed to play audio');
        }
    }
    
    // Optimized markdown parser with caching
    parseMarkdown(text) {
        if (!text) return '';
        
        // Escape HTML to prevent XSS
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        
        // Parse markdown elements (order matters!)
        html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
        
        // Bold and italic
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Lists
        html = html.replace(/^[\*\-\+] (.*)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>)/gs, function(match) {
            if (match.includes('</ul>')) return match;
            return '<ul>' + match + '</ul>';
        });
        html = html.replace(/<\/ul>\s*<ul>/g, '');
        
        // Line breaks and paragraphs
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');
        
        if (html.trim() && !html.startsWith('<h') && !html.startsWith('<ul') && !html.startsWith('<p>')) {
            html = '<p>' + html + '</p>';
        }
        
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
        
        // Optimized voice recording event listeners
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
    
    // Optimized message sending with early preparation
    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message) return;
        
        // Add user message immediately
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.sendButton.disabled = true;
        
        // Create loading message
        const loadingMessage = this.addMessage('assistant', '');
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading';
        loadingMessage.querySelector('.message-content').appendChild(loadingDiv);
        
        try {
            // Prepare request payload
            const requestPayload = {
                message, 
                sessionId: this.sessionId,
                tts: this.ttsEnabled
            };
            
            // Start request with optimized headers
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestPayload),
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Remove loading message
            loadingMessage.remove();
            
            // Create new message for streaming response
            const assistantMessage = this.addMessage('assistant', '');
            const messageContent = assistantMessage.querySelector('.message-content');
            
            // Handle streaming response with optimized buffer management
            await this.handleStreamingResponse(response, messageContent);
            
        } catch (error) {
            console.error('Error:', error);
            loadingMessage.querySelector('.message-content').innerHTML = 
                `<span style="color: red;">Error: ${error.message || 'Failed to get response'}</span>`;
        } finally {
            this.sendButton.disabled = false;
            this.messageInput.focus();
        }
    }
    
    // Optimized streaming response handler
    async handleStreamingResponse(response, messageContent) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        let buffer = '';
        const processChunk = async (chunk) => {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line in buffer
            
            // Process lines in batches for better performance
            const batchSize = 5;
            for (let i = 0; i < lines.length; i += batchSize) {
                const batch = lines.slice(i, i + batchSize);
                await this.processBatch(batch, messageContent);
                
                // Yield control to browser between batches
                if (i + batchSize < lines.length) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        };
        
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                await processChunk(value);
            }
        } catch (error) {
            console.error('Streaming error:', error);
            throw error;
        }
    }
    
    // Process batches of stream data
    async processBatch(lines, messageContent) {
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
        
        // Throttled scroll update
        this.scrollThrottled();
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
            case 'ttsLoading':
                this.addTTSLoadingSection(messageContent);
                break;
            case 'audio':
                this.removeTTSLoadingSection(messageContent);
                // Use requestAnimationFrame for smooth audio playback
                requestAnimationFrame(() => {
                    this.playAudio(data.audioData);
                });
                break;
            case 'ttsError':
                this.removeTTSLoadingSection(messageContent);
                this.showError(data.content);
                break;
            case 'complete':
                // Response complete
                break;
        }
    }
    
    // Optimized DOM manipulation methods
    addTTSLoadingSection(messageContent) {
        const ttsDiv = document.createElement('div');
        ttsDiv.className = 'tts-loading-section';
        ttsDiv.innerHTML = `
            <div class="tts-loading-header">
                <span class="tts-icon">🔊</span>
                <span>Generating speech...</span>
                <div class="loading-spinner"></div>
            </div>
        `;
        messageContent.appendChild(ttsDiv);
    }
    
    removeTTSLoadingSection(messageContent) {
        const ttsLoadingSection = messageContent.querySelector('.tts-loading-section');
        if (ttsLoadingSection) {
            ttsLoadingSection.remove();
        }
    }
    
    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #ef4444; color: white; padding: 12px 16px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; max-width: 300px; font-size: 14px;';
        errorDiv.textContent = message;
        document.body.appendChild(errorDiv);
        
        // Auto-remove with fade out
        setTimeout(() => {
            errorDiv.style.opacity = '0';
            errorDiv.style.transition = 'opacity 0.3s ease';
            setTimeout(() => {
                if (errorDiv.parentNode) {
                    errorDiv.parentNode.removeChild(errorDiv);
                }
            }, 300);
        }, 4700);
    }
    
    // Optimized message creation with document fragments
    addMessage(role, content) {
        const fragment = document.createDocumentFragment();
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message ' + role;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        
        if (role === 'user') {
            contentDiv.textContent = content;
        } else {
            contentDiv.innerHTML = this.parseMarkdown(content);
        }
        
        messageDiv.appendChild(contentDiv);
        fragment.appendChild(messageDiv);
        this.messagesContainer.appendChild(fragment);
        
        this.scrollThrottled();
        
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
        contentDiv.innerHTML = this.parseMarkdown(content);
        
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
        textDiv.innerHTML = this.parseMarkdown(content);
        messageContent.appendChild(textDiv);
    }
    
    // Helper function to escape HTML
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Optimized recording methods (keeping existing implementation but with better error handling)
    async startRecording() {
        if (this.isRecording) return;
        
        try {
            // Request microphone access with optimized settings
            this.stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 16000 // Lower sample rate for efficiency
                }
            });
            
            // Create MediaRecorder with optimized settings
            let mimeType = 'audio/webm;codecs=opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'audio/webm';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = 'audio/mp4';
                    if (!MediaRecorder.isTypeSupported(mimeType)) {
                        mimeType = '';
                    }
                }
            }
            
            this.mediaRecorder = new MediaRecorder(this.stream, {
                mimeType: mimeType || undefined,
                audioBitsPerSecond: 32000 // Optimized bitrate
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
            
            // Start recording with optimized interval
            this.mediaRecorder.start(250); // Collect data every 250ms
            this.isRecording = true;
            
            // Update UI
            this.recordButton.classList.add('recording');
            this.recordButton.querySelector('.record-text').textContent = 'Recording...';
            this.recordButton.querySelector('.record-icon').textContent = '⏹️';
            this.recordButton.disabled = false;
            
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
            
            // Check size limits
            if (audioBlob.size > 20 * 1024 * 1024) {
                throw new Error('Audio file too large (max 20MB)');
            }
            
            if (audioBlob.size < 1000) {
                throw new Error('Audio recording too short');
            }
            
            // Convert to base64 with optimization
            const base64Audio = await this.blobToBase64Optimized(audioBlob);
            
            // Send audio message
            await this.sendAudioMessage(base64Audio, mimeType);
            
        } catch (error) {
            console.error('Error processing recording:', error);
            this.handleRecordingError(error);
        } finally {
            this.resetRecording();
        }
    }
    
    // Optimized base64 conversion
    blobToBase64Optimized(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                try {
                    const base64String = reader.result.split(',')[1];
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
        
        // Create loading message
        const loadingMessage = this.addMessage('assistant', '');
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading';
        loadingMessage.querySelector('.message-content').appendChild(loadingDiv);
        
        try {
            const requestPayload = { 
                audioData, 
                sessionId: this.sessionId,
                tts: this.ttsEnabled
            };
            
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestPayload),
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Remove loading message
            loadingMessage.remove();
            
            // Create new message for streaming response
            const assistantMessage = this.addMessage('assistant', '');
            const messageContent = assistantMessage.querySelector('.message-content');
            
            // Handle streaming response
            await this.handleStreamingResponse(response, messageContent);
            
        } catch (error) {
            console.error('Error sending audio:', error);
            loadingMessage.querySelector('.message-content').innerHTML = 
                `<span style="color: red;">Error: ${error.message || 'Failed to process voice message'}</span>`;
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
        
        this.showError(errorMessage);
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

// Initialize the chat app when the page loads with performance optimization
document.addEventListener('DOMContentLoaded', () => {
    // Use requestIdleCallback for non-critical initialization if available
    if (window.requestIdleCallback) {
        requestIdleCallback(() => {
            new ChatApp();
        });
    } else {
        // Fallback for browsers without requestIdleCallback
        setTimeout(() => {
            new ChatApp();
        }, 0);
    }
});

// Add performance monitoring
if ('performance' in window) {
    window.addEventListener('load', () => {
        setTimeout(() => {
            const perfData = performance.getEntriesByType('navigation')[0];
            console.log('Page load performance:', {
                domContentLoaded: perfData.domContentLoadedEventEnd - perfData.domContentLoadedEventStart,
                loadComplete: perfData.loadEventEnd - perfData.loadEventStart,
                totalTime: perfData.loadEventEnd - perfData.fetchStart
            });
        }, 0);
    });
}