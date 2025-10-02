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

class Connection {
    constructor(peerManager, peerName, mainChannel, options) {
        this.peerManager = peerManager;
        this.peerName = peerName;
        this.mainChannel = mainChannel;
        this.options = options;
        this.connectionList = [];
        this.pc = new RTCPeerConnection(options.peerConnectionOptions??{});
        this.pc.ondatachannel = this.newDataChannel.bind(this);
        this.messageHandler = new Map();
        this.messageHandler.set('offer', this.handleOffer.bind(this));
        this.messageHandler.set('answer', this.handleAnswer.bind(this));
    }

    async newDataChannel(ev) {
        if (ev.channel.label === this.mainChannel) {
            this.dc = ev.channel;
            this.dc.onclose = this.mainDCClose.bind(this);
            this.dc.onmessage = this.mainDCMessage.bind(this);
            this.mainDCOpen();
        }
        else {
            this.peerManager.addChannel(this.peerName, ev.channel);
        }
    }

    async handleOffer(msg) {
        // If this isn't the connection to the server and we're still looking
        // for more connections then fire off an offer to this peer.
        if (this.peerManager.serverConnection !== this &&
            !this.newConnection &&
            this.peerManager.needMoreConnections()) {
            this.peerManager.sendConnectionRequest(this)
            .catch(err => {
                console.log('error while trying to send connection request to '+ this.peerName, err);
            });
        }
        // Check if we're still accepting connections.
        if (this.peerManager.acceptingConnections()) {
            return this.peerManager.createConnection(msg.from)
            .then( connection => {
                return this.peerManager.addPeer(msg.from, connection)
                .then( peer => {
                    return connection.pc.setRemoteDescription({type: 'offer', sdp: msg.sdp})
                })
                .then( something => {
                    return connection.pc.createAnswer();
                })
                .then( sdp => {
                    this.dc.send(JSON.stringify({
                        request: 'response',
                        to: msg.from,
                        sdp: sdp
                    }));
                    return connection.pc.setLocalDescription(sdp);
                })
                .catch( err => {
                    connection.pc.close();
                    this.dc.send(JSON.stringify({
                        request: 'reject',
                        to: msg.from,
                        sdp: msg.sdp
                    }));
                });
            });
        }
        // We are full!
        this.dc.send(JSON.stringify({
            request: 'reject',
            to: msg.from,
            sdp: msg.sdp
        }));
    }

    async handleAnswer(msg) {
        if (this.newConnection &&
            !this.closed &&
            !this.newConnection.closed) {
            this.newConnection.peerName = msg.from;
            this.newConnection.pc.setRemoteDescription(msg.sdp)
            .then( resp => {
                return this.peerManager.addPeer(msg.from, this.newConnection);
            })
            .then( newPeerConnection => {
                delete this.newConnection;
                if (this.peerManager.needMoreConnections()) {
                    return this.peerManager.sendConnectionRequest(this);
                }
            })
            .catch( err => {
                if (this.newConnection) {
                    this.newConnection.pc.close();
                    delete this.newConnection;
                }
            });
        }
    }

    async mainDCOpen() {
        if (this.peerManager.serverConnection.peerName !== this.peerName &&
            this.peerManager.connectionList[0]?.peerName !== this.peerName) {
            this.peerManager.connectionList.unshift(this);
        }
        if (!this.newConnection && this.peerManager.needMoreConnections()) {
            this.peerManager.sendConnectionRequest(this)
            .catch(err => {
                console.log('mainDCOpen send connection request failed', err);
            });
        }
    }

    async mainDCClose() {
        console.log('closed ' + this.peerName);
        this.closed = true;
    }

    async mainDCMessage(msgEv) {
        let data = JSON.parse(msgEv.data.toString());
        if (this.messageHandler.has(data.request)) {
            this.messageHandler.get(data.request)(data);
        }
        else {
            this.peerManager.handleMessage(this.peerName, data);
        }
    }

    async createSendOffer() {
        let pc = this.pc
        let sdpPromise = new Promise( (resolve, reject) => {
            pc.addEventListener('icegatheringstatechange', ev => {
                if (ev.target.iceGatheringState === 'complete') {
                    resolve(pc.localDescription.sdp);
                }
            });
        });
        this.dc = pc.createDataChannel(this.mainChannel, this.options.dataChannelOptions);
        this.dc.onopen = this.mainDCOpen.bind(this);
        this.dc.onclose = this.mainDCClose.bind(this);
        this.dc.onmessage = this.mainDCMessage.bind(this);
        return pc.createOffer()
        .then( offer => {
            return pc.setLocalDescription(offer);
        })
        .then( something => {
            return sdpPromise;
        });
    }
}

class PeerManager {
    constructor(name, mainChannel, defaultChannel, options) {
        this.mainChannel = mainChannel;
        this.defaultChannel = defaultChannel;
        this.name = name;
        this.options = options;
        this.peers = new Map();
        this.connectionList = [];
        this.channelHandlers = new Map();
        this.minConnections = options.minConnections??3;
        this.capConnections = options.capConnections??10;
        this.messageHandlers = new Map();
        this.messageHandlers.set('new', this.handleNewOffer.bind(this));
        this.messageHandlers.set('response', this.handleResponse.bind(this));
        this.messageHandlers.set('reject', this.handleRejection.bind(this));
        this.peerHandlers = new Map();
        this.intervalH = setInterval(this.updateConnectionList.bind(this), options.connectionInterval??300000);
    }

    acceptingConnections() {
        return (this.connectionList.filter(connection => !connection.closed).length < this.capConnections);
    }

    async addChannel(peer, channel) {
        if (this.channelHandlers.has(channel.label)) {
            this.channelHandlers.get(channel.label).forEach( async handler => {
                handler(peer, channel);
            });
        }
        else if (this.channelHandlers.has(this.defaultChannel)) {
            this.channelHandlers.get(this.defaultChannel).forEach( async handler => {
                handler(peer, channel);
            });
        }
    }

    async addPeer(name, connection) {
        if (this.peers.has(name) && !this.peers.get(name).closed) {
            return Promise.reject(new Error('connection for ' + name + ' already open'));
        }
        if (name === this.name) {
            return Promise.reject(new Error("That's me"));
        }
        this.peers.set(name, connection);
        this.peerHandlers.forEach( handler => {
            handler('add', name);
        });
        return Promise.resolve(this.peers.get(name));
    }

    connect(url) {
        return this.createConnection(this.name)
        .then( connection => {
            this.serverConnection = connection;
            return connection.createSendOffer();
        })
        .then( sdp => {
            return fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ name: this.name, sdp})
            });
        })
        .then( resp => {
            if (resp.ok) {
                return resp.json();
            }
            throw new Error('Fetch failed ' + resp.statusText);
        })
        .then( resp => {
            return this.serverConnection.pc.setRemoteDescription(resp.sdp);
        });
    }

    async createChannel(channelName, peerName, options) {
        if (!this.peers.has(peerName)) {
            return Promise.reject('Peer not found ' + peerName);
        }
        if (channelName === this.mainChannel) {
            return Promise.reject('Channel not available ' + channelName);
        }
        let dc = this.peers.get(peerName).pc.createDataChannel(channelName, options??this.options.dataChannelOptions);
        dc.onopen = () => { this.addChannel(peerName, dc); };
        return Promise.resolve(dc);
    }

    async createConnection(peerName) {
        return Promise.resolve(new Connection(this, peerName, this.mainChannel, (peerName === this.name)?{}:this.options));
    }

    async findConnection(peer, sdp) {
        if (this.peers.has(peer)) {
            let peerConnection = this.peers.get(peer);
            if (!peerConnection.closed) {
                let found = this.connectionList.find(connection => {
                    return !(peerConnection.connectionList.find(_connection => _connection.peerName === connection.peerName) || connection.closed);
                });
                if (found) {
                    peerConnection.connectionList.push(found);
                    found.dc.send(JSON.stringify({
                        request: 'offer',
                        from: peer,
                        sdp
                    }));
                }
                else {
                    peerConnection.dc.send(JSON.stringify({
                        request: 'reject',
                        sdp
                    }));
                }
            }
        }
    }

    async handleMessage(peer, msg) {
        if (this.messageHandlers.has(msg.request)) {
            this.messageHandlers.get(msg.request)(peer, msg);
        }
    }

    async handleNewOffer(peer, msg) {
        this.findConnection(peer, msg.sdp);
    }

    async handleRejection(peer, msg) {
        // Try and find a conection for the peer who sent the original request.
        if (msg.to && msg.to !== this.name) {
            this.findConnection(msg.to, msg.sdp);
        }
        else {
            if (this.newConnection) {
                this.newConnection.pc.close();
                delete this.newConnection;
            }
        }
    }

    async handleResponse(peer, msg) {
        this.sendMessage(msg.to, JSON.stringify({
            request: 'answer',
            from: peer,
            to: msg.to,
            sdp: msg.sdp
        }));
    }

    needMoreConnections() {
        return (this.connectionList.filter(connection => !connection.closed).length < this.minConnections);
    }

    async registerChannelHandler(name, handler) {
        if (typeof handler !== 'function') {
            return Promise.reject(new Error('channel handler for ' + name + ' is not a function'));
        }
        if (!this.channelHandlers.has(name)) {
            this.channelHandlers.set(name, []);
        }
        this.channelHandlers.get(name).push(handler);
        return Promise.resolve(true);
    }

    async registerMessageHandler(name, handler) {
        if (typeof handler !== 'function') {
            return Promise.reject(new Error('message handler for ' + name + ' is not a function'));
        }
        if (this.messageHandlers.has(name)) {
            return Promise.reject(new Error('message handler for ' + name + ' already registered'));
        }
        this.messageHandlers.set(name, handler);
        return Promise.resolve(true);
    }

    async registerPeerHandler(name, handler) {
        if (typeof handler !== 'function') {
            return Promise.reject(new Error('peer handler for ' + name + ' is not a function'));
        }
        if (this.peerHandlers.has(name)) {
            return Promise.reject(new Error('peer handler for ' + name + ' already registered'));
        }
        this.peerHandlers.set(name, handler);
        return Promise.resolve(true);
    }

    async sendConnectionRequest(currentConnection) {
        return this.createConnection()
        .then( connection => {
            if (currentConnection.newConnection) {
                connection.pc.close();
                throw new Error('New connection already exists');
            }
            currentConnection.newConnection = connection;
            return connection.createSendOffer();
        })
        .then( sdp => {
            currentConnection.dc.send(JSON.stringify({
                request: 'new',
                sdp: sdp
            }));
        });
    }

    async sendMessage(peer, msg) {
        const connection = this.peers.get(peer);
        if (connection && !connection.closed) {
            connection.dc.send(msg);
        }
    }

    async updateConnectionList() {
        let current = this.connectionList.filter(connection => !connection.closed)
                                         .map( connection => {
            return connection.pc.getStats()
            .then( stats => {
                let byteCount = 0;
                for (const stat of stats.values()) {
                    if (stat.type === 'transport') {
                        byteCount += (stat.bytesReceived + stat.bytesSent);
                    }
                }
                return Promise.resolve({connection, byteCount});
            });
        });
        Promise.all(current)
        .then( connections => {
            this.connectionList = connections
                                  .sort( (a,b) => {return a.byteCount - b.byteCount;})
                                  .map( connectionDetails => {return connectionDetails.connection;});
            while(this.connectionList.length > this.capConnections) {
                let connection = this.connectionList.pop();
                connection.pc.close();
            }
        });
    }
}
