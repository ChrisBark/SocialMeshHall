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

importScripts(
    '/js/ScatteredRangeRedBlackTree.js',
    '/js/FileSectorSelector.js'
);

class FileHandle {
    constructor(fileWorker, filepath) {
        this.fileWorker = fileWorker;
        this.filepath = filepath;
        this.numSectors = fileWorker.maxConnections;
        this.queue = [];
        this.ctrlQueue = [];
        this.pollH = setInterval(this.sendFilePackets.bind(this), fileWorker.pollingInterval);
    }

    async write(file, data) {
        return new Promise( (resolve, reject) => {
            let parts = this.filepath.split('/');
            if (parts.length < 5) {
                return reject(new Error('Filepath too short: ' + this.filepath));
            }
            // Assume it's the fileName on the end.
            const fileName = parts.pop();
            if (parts[0] === '') {
                parts.shift();
            }
            // Walk through the directories.
            return parts.reduce( (p, v) => {
                return p.then( dh => dh.getDirectoryHandle(v, {create: true}));
            }, navigator.storage.getDirectory())
            .then( dh => dh.getFileHandle(fileName, {create: true}))
            // Now load the file.
            .then( fh => {
                this.fileHandle = fh;
                return fh.createSyncAccessHandle();
            })
            .then( ah => {
                this.fileAccessHandle = ah;
                resolve(this.fileAccessHandle);
            });
        })
        .then( ah => {
            let written = 0;
            do {
                written += ah.write(data, {at: written});
            } while (written < data.byteLength);
            return this.setSize(ah.getSize(), data);
        })
        .then( sizeChanged => {
            this.fileAccessHandle.close();
            delete this.fileAccessHandle;
            delete this.fileHandle;
            return Promise.resolve(sizeChanged);
        })
        .catch( err => {
            console.log('load file error', err);
        });
    }

    async create(file, data) {
        return this.write(file, data)
        .then( sizeChanged => {
            this.rangeTree.setFull();
            // Trigger a swarm for the new file.
            this.swarm();
            return Promise.resolve(sizeChanged);
        });
    }

    open(peer, file) {
        // If we know the size of this file then just send a control
        // packet 
        if (peer && this.size) {
            return this.sendControlPacket(peer);
        }
        this.swarm();
    }

    async swarm() {
        postMessage({
            type: 'swarm',
            file: this.filepath
        });
    }

    async flush() {
        const queue = this.queue;
        this.queue = [];
        return queue.reduce( (p, v) => p.then(this.handleDataPacket(v.peer, v.file, v.index, v.buffer)), Promise.resolve(this));
    }

    // Returns a boolean to indicate if the size was set.
    async setSize(size, filedata) {
        return Promise.resolve(this.size)
        .then( storedSize =>{
            if (!storedSize) {
                this.size = size;
                this.numChunks = Math.ceil(size/this.fileWorker.mtu);
                this.rangeTree = new ScatteredRangeRedBlackTree(this.numChunks);
                this.buffer = filedata??new ArrayBuffer(size);
                this.bufferView = new Uint8Array(this.buffer);
                this.chunkCount = (new Array(size)).fill(0);
                this.fileSectorSelector = new FileSectorSelector(this.numChunks, this.numSectors);
                // Work through any queued data packets that were waiting for the
                // size to be set.
                this.flush();
                return Promise.resolve(true);
            }
            return Promise.resolve(false);
        });
    }

    async handleControlPacket(peer, file, buffer) {
        const peerInfo = this.fileWorker.peers.get(peer);
        if (!peerInfo) {
            return Promise.reject('Control packet from unknown peer: ' + peer + ' file: ' + file);
        }
        // Update the information for this peer.
        if (!peerInfo.hasOwnProperty(this.filepath)) {
            peerInfo[this.filepath] = {};
        }
        return this.setSize((buffer[0]<<32)|buffer[1])
        .then( sizeChanged => {
            // If this is the first time we've set the size then send out
            // control packets to all of our peers to let them know the size
            // of the file.
            if (sizeChanged) {
                this.fileWorker.peers.forEach( (peerInfo, _peer) => {
                    this.sendControlPacket(_peer).catch( err => {
                        console.error('Error sending control packet to peer', _peer, err);
                    });
                });
            }
            let rangeList = [];
            // Determine what they need.
            for(let i=0;i<buffer.length-2;i+=2) {
                rangeList.push([buffer[i*2], buffer[(i*2)+1]]);
            }
            // Generate an array of ranges that we have and they need.
            return this.rangeTree.generateAvailableIndexes(rangeList);
        })
        // Count how many packets we need for each sector. We split the file
        // into sectors that are further split into packets. This allows us
        // to attempt to get users to download different sectors of the file
        // so they can share their sectors with each other instead of
        // waiting for us to send everything.
        .then( eligibleList => this.fileSectorSelector.selectSector(eligibleList, peerInfo, peerInfo[this.filepath].currentSector?.sector))
        // Remember the selected sector for this peer.
        .then( sector => {
            if (sector?.chunks?.length) {
                peerInfo[this.filepath].currentSector = sector;
            }
            else {
                delete peerInfo[this.filepath].currentSector;
            }
        });
    }

    async handleDataPacket(peer, file, index, buffer) {
        // If we have the entire file then send a control packet to this peer.
        if (this.rangeTree.isComplete()) {
            this.sendControlPacket(peer).catch( err => {
                console.error('Error sending control packet to peer', peer, file);
            });
        }
        else if (this.size) {
            ++this.chunkCount[index];
            // If we've already seen this packet then send a control packet
            // and see if we can get the peer to send us packets from another
            // sector of the file.
            if (this.chunkCount[index] > 1) {
                this.sendControlPacket(peer).catch( err => {
                    console.error('Error sending control packet to peer', peer, file);
                });
            }
            else {
                this.rangeTree.add(index)
                .then( ignore => {
                    // Copy the data into our file buffer.
                    this.bufferView.set(buffer, index * this.fileWorker.mtu);
                    // If we have received everything then write the file.
                    // TODO - we can start writing the file before we receive the
                    // entire file.
                    if (this.rangeTree.isComplete()) {
                        return this.write(file, this.buffer)
                        .catch(err => {
                            // If we're open in another tab and didn't use
                            // readwrite-unsafe then createSyncAccessHandle()
                            // will probably fail.
                            return Promise.resolve(false);
                        })
                        .then( sizeChanged => {
                            postMessage({
                                type: 'file',
                                file: this.filepath,
                                data: this.buffer
                            });
                        });
                    }
                });
            }
        }
        else {
            // Queue up this data until we know how big the file is.
            this.queue.push({peer, file, index, buffer});
        }
    }

    // The control packet includes the size of the file and the list of file
    // chunks that we have.
    async sendControlPacket(peer) {
        return this.rangeTree.generateRange()
        .then( rangeList => {
            let data = new Uint32Array((rangeList.length*2) + 3);
            // We use -1 as the index for control packets.
            data[0] = 0xFFFFFFFF;
            data[1] = this.size & 0xFFFFFFFF;
            data[2] = (this.size>>32) & 0xFFFFFFFF;
            for (let i=0;i<rangeList.length;++i) {
                data[3 + (i*2)] = rangeList[i][0];
                data[4 + (i*2)] = rangeList[i][1];
            }
            postMessage({
                type: 'send',
                file: this.filepath,
                peer,
                data
            }, []);
        });
    }

    async sendFilePacket(peer, index) {
        // If there's less the the maximum transmission units left we need to
        // send less then the mtu.
        const packetStart = this.fileWorker.mtu * index;
        const packetBoundary = this.fileWorker.mtu * (index + 1);
        let size = (packetBoundary > this.size) ? this.size % this.fileWorker.mtu : this.fileWorker.mtu;
        // Create a buffer of the index for copying into the data buffer.
        let dataIndex = new Uint32Array(1);
        dataIndex[0] = index;
        // Create the data buffer.
        let data = new Uint8Array(size+4);
        // Copy the index in first.
        data.set(dataIndex.buffer);
        // Copy the file data in.
        data.set(this.buffer.slice(packetStart, packetStart + size), 4);
        postMessage({
            type: 'send',
            file: this.filepath,
            peer,
            data
        });
    }

    async sendFilePackets() {
        (this.fileWorker?.peers??[]).forEach( (peerInfo, peer) => {
            const fileInfo = peerInfo[this.filepath];
            if (fileInfo.currentSector) {
                const sector = fileInfo.currentSector;
                // See if we have a range of chunks to send.
                if (sector.chunks?.length) {
                    sector.nextIndex = sector.chunks[0][0]++;
                    if (sector.nextIndex > sector.chunks[1]) {
                        chunks.shift();
                        if (sector.chunks.length) {
                            sector.nextIndex = sector.chunks[0][0]++;
                        }
                        else {
                            // Use the nextIndex calculated above, if it's
                            // something the other side has already seen then
                            // they will send a control packet.
                            // Wrap around the end of the file.
                            if (sector.nextIndex >= this.size) {
                                sector.nextIndex = 0;
                            }
                        }
                    }
                    this.sendFilePacket(peer, sector.nextIndex);
                }
            }
        });
    }
}

class FileWorker {
    constructor() {
        this.peers = new Map();
        this.files = new Map();
    }

    async init(maxConnections, mtu, pollingInterval) {
        this.maxConnections = maxConnections;
        this.mtu = mtu;
        this.pollingInterval = pollingInterval;
    }

    async create(file, data) {
        if (this.files.has(file)) {
            return Promise.reject('This file already exists: ' + file);
        }
        this.files.set(file, new FileHandle(this, file));
        return this.files.get(file).create(file, data);
    }

    async open(peer, file) {
        if (!this.files.has(file)) {
            this.files.set(file, new FileHandle(this, file));
        }
        return this.files.get(file).open(peer, file);
    }

    async generateFileList(peer) {
        let fileList = [];
        this.files.forEach( (fileInfo, filename) => {
            fileList.push(filename);
        });
        postMessage({
            type: 'list',
            files: fileList,
            peer
        });
    }

    async handleFileData(peer, file, data) {
        const fileH = this.files.get(file);
        if (!fileH) return;
        const uint32View = new Uint32Array(data);
        const index = uint32View[0];
        // Lazy-load peer info.
        if (!this.peers.has(peer)) {
            this.peers.set(peer, {});
        }
        if (index === 0xFFFFFFFF) {
            return fileH.handleControlPacket(peer, file, uint32View.slice(1));
        }
        else {
            return fileH.handleDataPacket(peer, file, index, new Uint8Array(uint32View.slice(1).buffer));
        }
    }
}

const _worker = new FileWorker();

onmessage = ev => {
    const msg = ev.data;
    switch(msg.request) {
        case 'create':
            _worker.create(msg.file, msg.data).catch( err => {
                console.error('file creation error', err);
            });
            break;
        case 'data':
            _worker.handleFileData(msg.peer, msg.file, msg.data).catch( err => {
                console.error('file data error', err);
            });
            break;
        case 'init':
            _worker.init(msg.max, msg.mtu, msg.pollingInterval);
            break;
        case 'list':
            _worker.generateFileList(msg.peer).catch( err => {
                console.error('file list generation error', err);
            });
            break;
        case 'open':
            return _worker.open(msg.peer, msg.file).catch( err => {
                console.error('file open error', err);
            });
            break;
        default:
            break;
    }
}

