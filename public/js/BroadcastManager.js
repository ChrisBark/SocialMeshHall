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
    constructor(peerCfg, broadcastMgr, peer, channel, audio, video, isRx) {
        this.peerConnection = new RTCPeerConnection(peerCfg);
        this.iceCandidates = [];
        this.broadcastMgr = broadcastMgr;
        this.peer = peer;
        this.channel = channel;
        this.isRx = isRx;
        this.trackTargets = new Map();
        if (audio) {
            this.trackTargets.set('audio', false);
        }
        if (video) {
            this.trackTargets.set('video', false);
        }
        this.retransmitPeers = [];
        this.peerConnection.addEventListener('icecandidate', this.sendIceCandidate.bind(this));
        this.peerConnection.addEventListener('connectionstatechange', this.connectionStateChange.bind(this));
        this.peerConnection.addEventListener('track', this.addTrack.bind(this));
    }

    addIceCandidate(candidate) {
        if (this.peerConnection.currentRemoteDescription) {
            this.peerConnection.addIceCandidate(candidate)
            .catch( err => {
                console.error('Error adding ice candidate', err);
            });
        }
        else {
            this.iceCandidates.push(candidate);
        }
    }

    addTrack(ev) {
        this.trackTargets.set(ev.track.kind, true);
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
        this.stream = stream;
        stream.getTracks().forEach(track => {
            this.trackTargets.set(track.kind, true);
            this.peerConnection.addTrack(track, stream);
        });
        if (this.fullStreamAvailable()) {
            this.broadcastMgr.sendPeerList(this.channel);
        }
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
        .then( async ignore => {
            while (this.iceCandidates.length) {
                await this.peerConnection.addIceCandidate(this.iceCandidates.shift());
            }
            return this.peerConnection.createAnswer();
        })
        .then( answer => {
            this.peerConnection.setLocalDescription(answer)
            .then( ignore => {
                this.channel.send(JSON.stringify({type: 'answer', peer: this.peer, offer: answer}));
            });
        });
    }

    async createOffer() {
        this.peerConnection.createOffer()
        .then( offer => {
            this.peerConnection.setLocalDescription(offer)
            .then( ignore => {
                this.channel.send(JSON.stringify({type: 'offer', peer: this.peer, offer}));
            });
        });
    }

    fullStreamAvailable() {
        let complete = true;
        for (const value of this.trackTargets.values()) {
            complete &&= value;
        }
        return complete;
    }

    async loadedMetaData(ev) {
    }

    async sendIceCandidate(ev) {
        this.channel.send(JSON.stringify({type: 'ice', peer: this.peer, candidate: ev.candidate, isRx: !this.isRx}));
    }

    async setAnswer(answer) {
        await this.peerConnection.setRemoteDescription(answer);
        while (this.iceCandidates.length) {
            await this.peerConnection.addIceCandidate(this.iceCandidates.shift());
        }
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
        // We have direct connections to peers.
        this.peers = new Map();
        // WE could have peer streams coming indirectly through a third party
        this.peerRxStreams = new Map();
        this.messageQueue = [];
        goLiveButtonElem.addEventListener('click', this.goLive.bind(this));
        goLiveAudioButtonElem.addEventListener('click', this.goLiveAudio.bind(this));
        stopButtonElem.addEventListener('click', this.stop.bind(this));
        this.peerMgr.registerPeerHandler('broadcastmanager', this.handlePeerEvent.bind(this));
        this.pollH = setInterval(this.handleMessages.bind(this), 10);
    }

    async broadcastLive(audio, video) {
        if (this.stream) {
            return Promise.reject('Already live');
        }
        // Create the stream.
        return this.createUserMedia(audio, video)
        .then( stream => {
            this.stream = stream;
            this.audio = audio;
            this.video = video;
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
            if (peerInfo.txStreams.has(this.peerMgr.name)) {
                const broadcastStream = peerInfo.txStreams.get(this.peerMgr.name);
                broadcastStream?.channel?.send(JSON.stringify({type: 'close', peer: this.peerMgr.name}));
                broadcastStream?.close();
                peerInfo.txStreams.delete(this.peerMgr.name);
            }
        });
    }

    async closeStreams(peer) {
        this.peers.forEach( peerInfo => {
            if (peerInfo.txStreams.has(peer)) {
                const broadcastStream = peerInfo.txStreams.get(peer);
                peerInfo.txStreams.delete(peer);
                broadcastStream?.channel?.send(JSON.stringify({type: 'close', peer}));
                broadcastStream?.close();
            }
        });
        this.peerRxStreams.get(peer)?.close();
        this.peerRxStreams.delete(peer);
    }

    async createBroadcastStream(peer, targetPeer, channel) {
        var broadcastStream;
        let peerTargetInfo = this.peers.get(targetPeer);
        // Is this our stream?
        if (peer === this.peerMgr.name) {
            broadcastStream = new BroadcastStream(this.peerCfg, this, peer, channel, this.audio, this.video, false);
            broadcastStream.addTracksToPeer(this.stream);
        }
        else {
            // Make sure we have a broadcast stream to retransmit.
            const rxBroadcastStream = this.peerRxStreams.get(peer);
            if (rxBroadcastStream) {
                broadcastStream = new BroadcastStream(this.peerCfg, this, peer, channel, rxBroadcastStream.audio, rxBroadcastStream.video, false);
                broadcastStream.addTracksToPeer(rxBroadcastStream.stream);
                rxBroadcastStream.retransmitPeers.push(targetPeer);
            }
        }
        // Just in case we didn't crate the broadcast stream above.
        if (broadcastStream) {
            peerTargetInfo.txStreams.set(peer, broadcastStream);
            broadcastStream.createOffer();
        }
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
        // Handle remote offers.
        channel.addEventListener('message', async (msgEv) => {
            // Queue this message.
            this.messageQueue.push({channel, peer, data: msgEv.data});
        });
        const peerInfo = this.peers.get(peer);
        peerInfo.channel = channel;
        channel.onclose = () => {
            delete peerInfo.channel;
        };
        setTimeout(() => {
            this.sendPeerList(channel);
        }, 50)
    }

    async handleMessages() {
        let msgData = this.messageQueue.shift();
        if (msgData) {
            this.handleMessage(msgData.channel, msgData.peer, msgData.data);
        }
    }

    async handleMessage(channel, peer, msgData) {
        const peerInfo = this.peers.get(peer);
        try {
            const msg = JSON.parse(msgData);
            switch (msg.type) {
                case 'answer':
                    peerInfo.txStreams.get(msg.peer)?.setAnswer(new RTCSessionDescription(msg.offer));
                    break;
                case 'connect':
                    this.createBroadcastStream(msg.peer, peer, channel);
                    break;
                case 'close':
                    this.closeStreams(msg.peer);
                    break;
                case 'ice':
                    (msg.isRx?this.peerRxStreams.get(msg.peer):peerInfo.txStreams.get(msg.peer))?.addIceCandidate(msg.candidate);
                    break;
                case 'offer':
                    this.peerRxStreams.get(msg.peer)?.createAnswer(new RTCSessionDescription(msg.offer));
                    break;
                case 'peerlist':
                    // Determine which peers aren't in our collection and
                    // create a BroadcastStream object for each new peer
                    // using the channel we were told about the peer over.
                    (msg.peerlist??[]).filter(peerDetails => !this.peerRxStreams.has(peerDetails.peer)).forEach( peerDetails => {
                        const peerBroadcastStream = new BroadcastStream(this.peerCfg, this, peerDetails.peer, channel, peerDetails.audio, peerDetails.video, true);
                        this.peerRxStreams.set(peerDetails.peer, peerBroadcastStream);
                        // Add a video element to the DOM.
                        peerBroadcastStream.addVideoElement(this.postMgr.addLivePost('L' + peerDetails.peer));
                        channel.send(JSON.stringify({type: 'connect', peer: peerDetails.peer}));
                    });
                    break;
                default:
                    break;
            }
        }
        catch (err) {
            console.error('Error handling message', msgData, err);
        }
    }

    async handlePeerEvent(type, peer) {
        if (type === 'add') {
            this.peers.set(peer, {txStreams: new Map()});
            // If we're already live then we'll want to create the SDP
            // channel for this new peer.
            if (this.stream) {
                this.createSDPChannel(peer);
            }
        }
        else if (type === 'remove') {
            const peerInfo = this.peers.get(peer);
            this.peers.delete(peer);
            if (peerInfo?.channel && peerInfo.channel.readyState !== 'closed') {
                peerInfo.channel.close();
            }
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

    async sendPeerList(channel) {
        let peerlist = [];
        if (this.stream) {
            peerlist.push({peer:this.peerMgr.name, audio: !!this.audio, video: !!this.video});
        }
        this.peerRxStreams.forEach( (broadcastStream, peer) => {
            if (broadcastStream.fullStreamAvailable()) {
                peerlist.push({peer, audio: broadcastStream.audio, video: broadcastStream.video});
            }
        });
        if (peerlist.length) {
            channel.send(JSON.stringify({type: 'peerlist', peerlist}));
        }
    }

    async stop() {
        this.broadcastStop();
        this.goLiveButtonElem.classList.remove('hidden');
        //this.goLiveAudioButtonElem.classList.remove('hidden');
        this.stopButtonElem.classList.add('hidden');
    }
}

