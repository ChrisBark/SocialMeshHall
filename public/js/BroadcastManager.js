'use strict';

/*
 * Copyright 2026 Christopher Bark
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

class BroadcastStream {
    constructor(peerCfg, peer, channel) {
        this.peerConnection = new RTCPeerConnection(peerCfg);
        this.peer = peer;
        this.channel = channel;
        this.peerConnection.addEventListener('icecandidate', this.sendIceCandidate.bind(this));
        this.peerConnection.addEventListener('connectionstatechange', this.connectionStateChange.bind(this));
        this.peerConnection.addEventListener('track', this.addTrack.bind(this));
    }

    addIceCandidate(candidate) {
        this.peerConnection.addIceCandidate(candidate)
        .catch( err => {
            console.error('Error adding ice candidate', err);
        });
    }

    addTrack(ev) {
        ev.track.addEventListener('ended', ev => {
            this.close();
        });
        if (this.videoElem) {
            let videoElements = this.videoElem.getElementsByTagName('video');
            for (const video of videoElements) {
                if (video.srcObject !== ev.streams[0]) {
                    video.srcObject = ev.streams[0];
                }
            }
        }
    }

    addTracksToPeer(stream) {
        stream.getTracks().forEach(track => {
            this.peerConnection.addTrack(track, stream);
        });
    }

    addVideoElement(videoElem) {
        this.videoElem = videoElem;
        for (const video of videoElem.getElementsByTagName('video')) {
            video.addEventListener('loadedmetadata', this.loadedMetaData.bind(this));
        }
    }

    async close() {
        if (this.peerConnection.connectionState !== 'closed') {
            this.peerConnection.close();
        }
        if (this.videoElem?.parentNode) {
            this.videoElem.parentNode.removeChild(this.videoElem);
        }
    }

    async connectionStateChange(ev) {
        if (this.peerConnection.connectionState === 'disconnected') {
            if (this.videoElem?.parentNode) {
                this.videoElem.parentNode.removeChild(this.videoElem);
                delete this.videoElem;
            }
            this.peerConnection.close();
        }
    }

    async createAnswer(offer) {
        this.peerConnection.setRemoteDescription(offer)
        .then( ignore => {
            return this.peerConnection.createAnswer();
        })
        .then( answer => {
            this.peerConnection.setLocalDescription(answer)
            .then( ignore => {
                this.channel.send(JSON.stringify({peer: this.peer, offer: answer}));
            });
        });
    }

    async createOffer() {
        this.peerConnection.createOffer()
        .then( offer => {
            this.peerConnection.setLocalDescription(offer)
            .then( ignore => {
                this.channel.send(JSON.stringify({peer: this.peer, offer}));
            });
        });
    }

    async loadedMetaData(ev) {
    }

    async sendIceCandidate(ev) {
        this.channel.send(JSON.stringify({peer: this.peer, candidate: ev.candidate}));
    }

    async setAnswer(answer) {
        this.peerConnection.setRemoteDescription(answer);
    }
}

class BroadcastManager {
    constructor(postMgr,
                peerMgr,
                goLiveButtonElem,
                goLiveAudioButtonElem,
                stopButtonElem,
                peerCfg) {
        this.postMgr = postMgr;
        this.peerMgr = peerMgr;
        this.goLiveButtonElem = goLiveButtonElem;
        this.goLiveAudioButtonElem = goLiveAudioButtonElem;
        this.stopButtonElem = stopButtonElem;
        this.peerCfg = peerCfg;
        this.peers = new Map();
        goLiveButtonElem.addEventListener('click', this.goLive.bind(this));
        goLiveAudioButtonElem.addEventListener('click', this.goLiveAudio.bind(this));
        stopButtonElem.addEventListener('click', this.stop.bind(this));
        this.peerMgr.registerPeerHandler('broadcastmanager', this.handlePeerEvent.bind(this));
    }

    async createSDPChannel(peer) {
        this.peerMgr.createChannel('sdp', peer);
    }

    async createUserMedia(audio, video) {
        return navigator.mediaDevices.getUserMedia({ audio, video })
        .then( stream => {
            if ((audio && !this.audioInputsLoaded) || (video && !this.videoInputsLoaded)) {
                if (audio) {
                    this.audioInputsLoaded = true;
                }
                if (video) {
                    this.videoInputsLoaded = true;
                }
                this.loadInputDevices();
            }
            return Promise.resolve(stream);
        });
    }

    async broadcastLive(audio, video) {
        if (this.stream) {
            return Promise.reject('Already live');
        }
        // Create the stream.
        return this.createUserMedia(audio, video)
        .then( stream => {
            this.stream = stream;
            this.goLiveButtonElem.classList.add('hidden');
            //this.goLiveAudioButtonElem.classList.add('hidden');
            this.stopButtonElem.classList.remove('hidden');
            // Open data channels for SDP negotiation.
            this.peers.forEach( (peerInfo, peer) => {
                if (!peerInfo.channel) {
                    this.createSDPChannel(peer);
                }
            });
            const videoWrapper = this.postMgr.addLivePost('L' + this.peerMgr.name);
            let videoElements = videoWrapper.getElementsByTagName('video');
            for (const video of videoElements) {
                video.srcObject = stream;
            }
            this.videoElem = videoWrapper;
        });
    }

    async broadcastStop() {
        this.stream.getTracks().forEach( track => {
            track.stop();
        });
        this.videoElem.parentNode.removeChild(this.videoElem);
        delete this.videoElem;
        this.peers.forEach( (peerInfo, peer) => {
            if (peerInfo.streams.has(this.peerMgr.name)) {
                peerInfo.streams.get(this.peerMgr.name).close();
                peerInfo.streams.delete(this.peerMgr.name);
            }
        });
    }

    async goLive() {
        this.broadcastLive(true, true).catch( err => {
            if (err.name !== 'NotAllowedError') {
                console.error('broadcast error', err);
            }
        });
    }

    async goLiveAudio() {
    /*
        this.goLiveButtonElem.classList.add('hidden');
        this.goLiveAudioButtonElem.classList.add('hidden');
        this.stopButtonElem.classList.remove('hidden');
        this.broadcastLive(true, false);
     */
    }

    // Called for every new SDP channel created.
    async handleChannel(peer, channel) {
        let peerInfo = this.peers.get(peer);
        peerInfo.channel = channel;
        channel.onclose = () => {
            delete peerInfo.channel;
        };
        // Handle remote offers.
        channel.onmessage = (msgEv) => {
            const msg = JSON.parse(msgEv.data);
            if (peerInfo.streams.has(msg.peer)) {
                if (msg.offer) {
                    peerInfo.streams.get(msg.peer).setAnswer(new RTCSessionDescription(msg.offer));
                }
                else if (msg.candidate) {
                    peerInfo.streams.get(msg.peer).addIceCandidate(msg.candidate);
                }
            }
            else {
                const broadcastStream = new BroadcastStream(this.peerCfg, peer, channel);
                peerInfo.streams.set(peer, broadcastStream);
                broadcastStream.createAnswer(new RTCSessionDescription(msg.offer));
                broadcastStream.addVideoElement(this.postMgr.addLivePost('L' + peer));
            }
        };
        // Create the peer connection for this channel.
        if (this.stream) {
            const broadcastStream = new BroadcastStream(this.peerCfg, this.peerMgr.name, channel);
            peerInfo.streams.set(this.peerMgr.name, broadcastStream);
            broadcastStream.addTracksToPeer(this.stream);
            broadcastStream.createOffer();
        }
    }

    async handlePeerEvent(type, peer) {
        if (type === 'add') {
            this.peers.set(peer, {streams: new Map()});
            // If we're already live then we'll want to create the SDP
            // channel for this new peer.
            if (this.stream) {
                this.createSDPChannel(peer);
            }
        }
        else if (type === 'remove') {
            const peerInfo = this.peers.get(peer);
            this.peers.delete(peer);
            if (peerInfo.channel && peerInfo.channel.readyState !== 'closed') {
                peerInfo.channel.close();
                delete peerInfo.channel;
            }
            peerInfo.streams.forEach( broadcastStream => {
                broadcastStream.close();
            });
            // TODO - remove HTML elements.
        }
    }

    async loadInputDevices() {
    /* At some point we'll want to load the devices and create a popup menu of
     * audio/video devices that will allow the user to change inputs (exmaple
     * switch to the rear facing camera instead of using the default front
     * facing one).
        navigator.mediaDevices.enumerateDevices()
        .then( devices => {
            for (const device of devices) {
                // https://developer.mozilla.org/en-US/docs/Web/API/MediaDeviceInfo/label
                if (device.kind === 'audioinput') {
                }
                else if (device.kind === 'videoinput') {
                }
            }
        });
     */
    }

    async stop() {
        this.broadcastStop();
        this.goLiveButtonElem.classList.remove('hidden');
        //this.goLiveAudioButtonElem.classList.remove('hidden');
        this.stopButtonElem.classList.add('hidden');
    }
}

