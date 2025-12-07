'use strict';

/*
 * Copyright 2025 Christopher Bark
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 *
 * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 * Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

class FileManager {
    constructor(fileInput, peerMgr, imageTemplate, videoTemplate, commentTemplate, postsDiv, options) {
        this.peerMgr = peerMgr;
        this.options = options;
        this.fileInput = fileInput;
        this.imageTemplate = imageTemplate;
        this.videoTemplate = videoTemplate;
        this.commentTemplate = commentTemplate;
        this.postsDiv = postsDiv;
        this.fileWorker = new Worker('../js/FileWorker.js');
        this.fileChannels = new Map();
    }

    async init() {
        return new Promise( (resolve, reject) => {
            this.peerMgr.registerPeerHandler('filemanager', this.handlePeerEvent.bind(this));
            this.peerMgr.registerChannelHandler(this.options.defaultChannel, this.handleFileChannel.bind(this));
            this.fileInput.addEventListener('change', this.shareFiles.bind(this));
            this.fileWorker.addEventListener('error', this.handleFileWorkerError.bind(this));
            this.fileWorker.addEventListener('message', this.handleFileWorkerMessage.bind(this));
            this.fileWorker.addEventListener('messageerror', this.handleFileWorkerMessageError.bind(this));
            this.fileWorker.postMessage({ request: 'init', max: this.options.capConnections??10, mtu: this.options.mtu??1400, pollingInterval: this.options.pollingInterval??10 });
            return resolve(true);
        });
    }

    async load(filepath) {
        const parts = filepath.split('/');
        if (parts.length < 5) {
            return Promise.reject(new Error('Filepath too short: ' + filepath));
        }
        if (parts[0] === '') {
            parts.shift();
        }
        // Assume it's the fileName on the end.
        const fileName = parts.pop();
        return parts.reduce( (p, v) => {
            return p.then( dh => dh.getDirectoryHandle(v, {create: true}));
        }, Promise.resolve(navigator.storage.getDirectory()))
        .then( dh => dh.getFileHandle(fileName, {create: true}));
    }

    async loadSharedFile(filepath, data) {
        const fileext = filepath.split('.').pop().toLowerCase();
        switch(fileext) {
            case 'png':
            case 'bmp':
            case 'gif':
                return this.loadImage(filepath, fileext, data);
            case 'jpeg':
            case 'jpg':
                return this.loadImage(filepath, 'jpeg', data);
            case 'svg':
                return this.loadImage(filepath, 'svg+xml', data);
            case 'mp4':
            case 'wemb':
                return this.loadVideo(filepath, fileext, data);
            default:
                break;
        }
    }

    async loadImage(filepath, fileext, data) {
        let newImage = this.imageTemplate.cloneNode(true);
        let imgElements = newImage.getElementsByTagName('img');
        return new Promise( (resolve, reject) => {
            for (const img of imgElements) {
                img.src = URL.createObjectURL(new Blob([data], { type: 'image/' + fileext }));
            }
            this.postsDiv.appendChild(newImage);
            resolve(true);
        });
    }

    async loadVideo(filepath, fileext, data) {
        let newVideo = this.videoTemplate.cloneNode(true);
        let videoElements = newVideo.getElementsByTagName('video');
        return new Promise( (resolve, reject) => {
            for (const video of videoElements) {
                video.src = URL.createObjectURL(new Blob([data], { type: 'video/' + fileext }));
                video.load();
            }
            this.postsDiv.appendChild(newVideo);
            resolve(true);
        });
    }

    async handleFileWorkerMessage(ev) {
        const msg = ev.data;
        switch (msg.type) {
            case 'file':
                // New file to load into the DOM!
                this.loadSharedFile(msg.file, msg.data).catch( err => {
                    console.error('Failed to load shared file ' + msg.file, err);
                });
                break;
            case 'list':
                // Create channels for any files the peer doesn't have.
                if (this.fileChannels.has(msg.peer)) {
                    const channelMap = this.fileChannels.get(msg.peer);
                    (msg.files??[]).forEach( file => {
                        if (!channelMap.has(file)) {
                            this.peerMgr.createChannel(file, msg.peer)
                        }
                    });
                }
                break;
            case 'send':
                if (this.fileChannels.has(msg.peer)) {
                    const channelMap = this.fileChannels.get(msg.peer);
                    if (channelMap?.has(msg.file)) {
                        channelMap.get(msg.file).send(msg.data);
                    }
                }
                break;
            case 'swarm':
                // If the file worker requested a swarm then open this channel
                // for every peer that does not already have it open.
                this.fileChannels.forEach( (channelMap, peer) => {
                    if (!channelMap.has(msg.file)) {
                        this.peerMgr.createChannel(msg.file, peer)
                    }
                });
                break;
            case 'close':
                if (this.fileChannels.has(msg.peer)) {
                    const channelMap = this.fileChannels.get(msg.peer);
                    if (channelMap.has(msg.file)) {
                        const channel = channelMap.get(msg.file);
                        channelMap.delete(msg.file);
                        channel.close();
                    }
                }
                break;
            default:
                console.error('unknown message received from file worker', msg, ev);
                break;
        }
    }

    async handleFileWorkerError(ev) {
        console.error(`worker error ${ev} ${ev.message} ${ev.filename} ${ev.lineno}`);
    }

    async handleFileWorkerMessageError(ev) {
        console.error(`worker message error ${ev}`);
    }

    async handleFileChannel(peer, channel) {
        if (!this.fileChannels.has(peer)) {
            this.fileChannels.set(peer, new Map());
        }
        this.fileChannels.get(peer).set(channel.label, channel);
        channel.onclose = () => {
            if (this.fileChannels.has(peer)) {
                this.fileChannels.get(peer).delete(channel.label);
            }
        };
        channel.onmessage = (msgEv) => {
            this.fileWorker.postMessage({ request: 'data', peer, file: channel.label, data: msgEv.data });
        };
        this.fileWorker.postMessage({ request: 'open', peer, file: channel.label });
    }

    async handlePeerEvent(type, peer) {
        if (type === 'add') {
            if (this.fileChannels.has(peer)) {
                console.error('Peer ' + peer + ' already exists, replacing');
            }
            this.fileChannels.set(peer, new Map());
            // Generate a list of channels to possibly open.
            this.fileWorker.postMessage({ request: 'list', peer });
        }
        else if (type === 'remove') {
            this.fileChannels.delete(peer);
        }
    }

    async shareFiles() {
        let now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth();
        const date = now.getUTCDate();
        const ts = now.getTime();
        const path = `/${year}/${month}/${date}/${ts}/`;
        for (const file of this.fileInput.files) {
            let reader = new FileReader();
            let filename = path + file.name;
            reader.onload = ev => {
                this.loadSharedFile(filename, reader.result)
                .then( result => {
                    this.fileWorker.postMessage({ request: 'create', file: filename, data: reader.result }, [reader.result]);
                });
            };
            reader.readAsArrayBuffer(file);
        }
    }
}

