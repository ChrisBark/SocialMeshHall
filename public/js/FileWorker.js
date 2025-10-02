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

class FileHandle {
    constructor(fileWorker, filepath) {
        this.fileWorker = fileWorker;
        this.filepath = filepath;
        this.numSectors = fileWorker.maxConnections;
        this.queue = [];
        this.ctrlQueue = [];
        this.pollH = setInterval(this.sendFilePackets.bind(this), fileWorker.pollingInterval);
    }

    loadFile(filedata) {
        const parts = this.filepath.split('/');
        if (parts.length < 5) {
            return Promise.reject(new Error('Filepath too short: ' + this.filepath));
        }
        // Assume it's the fileName on the end.
        const fileName = parts.pop();
        // Walk through the directories.
        return parts.reduce( (p, v) => {
            return p.then( dh => dh.getDirectoryHandle(v, {create: true}));
        }, navigator.storage.getDirectory())
        // Now load the file.
        .then( dh => dh.getFileHandle(fileName, {create: true}))
        .then( fh => {
            this.fileHandle = fh;
            return fh.createSyncAccessHandle();
        })
        .then( ah => {
            this.fileAccessHandle = ah;
            // If this is called with the full file we need to write it first.
            if (filedata) {
                let written = 0;
                do {
                    written += ah.write(filedata, {at: written});
                } while (written < filedata.byteLength);
            }
            // If we have this file, or just wrote it above, then this will be 
            // non-zero.
            if (ah.getSize()) {
                return this.setSize(ah.getSize(), filedata)
                .then( sizeChanged => {
                    // If we weren't given file date then we need to read it
                    // from the file.
                    if (!filedata) {
                        const buffer = new DataView(this.buffer);
                        this.readLength = ah.read(buffer, { at: 0 });
                        while(this.readLength < this.size) {
                            this.readLength += ah.read(buffer, { at: this.readLength });
                        }
                    }
                    // We don't need to keep the handle  open if we have
                    // the full file read into the buffer.
                    ah.close();
                    // Mark the range tree as full.
                    return this.rangeTree.setFull();
                })
                .then( ignore => {
                    // If we just loaded this file then force a swarm.
                    if (filedata) {
                        this.swarm();
                    }
                    else {
                        // Send out the control packet to let them know how big
                        // the file is.
                        this.fileWorker.peers.forEach( (peerInfo, peer) => {
                            this.sendControlPacket(peer);
                        });
                    }
                    return Promise.resolve(this);
                });
            }
            // If we don't have the file then trigger a swarm.
            else {
                this.swarm();
            }
            return Promise.resolve(this);
        })
        .catch( err =>{
            // TODO check the error in case the file system is full or some
            // other issue we don't expect happens.
            // For now we'll assume that the file access handle has already
            // been opened by someone else.
            return Promise.resolve(this);
        });
    }

    async swarm() {
        postMessage({
            type: 'swarm',
            file: this.filepath
        });
    }

    // Returns a boolean to indicate if the size was set.
    async setSize(size, filedata) {
        return Promise.resolve(this.size)
        .then( storedSize =>{
            if (!storedSize) {
                this.numChunks = Math.ceil(size/this.fileWorker.mtu);
                this.rangeTree = new ScatteredRangeRedBlackTree(this.numChunks);
                this.buffer = filedata??new ArrayBuffer(size);
                this.bufferView = new Uint8Array(this.buffer);
                this.chunkCount = (new Array(size)).fill(0);
                this.size = size;
                this.fileSectorSelector = new FileSectorSelector(this.numChunks, this.numSectors);
                // Work through any queued data packets that were waiting for the
                // size to be set.
                return Promise.resolve(this.queue.reduce( (p, v) => p.then(this.handleDataPacket(v.peer, v.file, v.index, v.buffer)), Promise.resolve(this)))
                .then( ignore => {
                    this.queue = [];
                    return Promise.resolve(true);
                });
            }
            return Promise.resolve(false);
        });
    }

    async handleControlPacket(peer, file, buffer) {
        const peerInfo = this.fileWorker.peers.get(peer);
        if (!peerInfo) {
            return;
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
                    this.sendControlPacket(_peer);
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
        .then( eligibleList => this.fileSectorSelector.selectSector(eligibleList, peerInfo, peerInfo.currentSector?.sector))
        // Remember the selected sector for this peer.
        .then( sector => {
            if (sector.chunks.length) {
                peerInfo[this.filepath].currentSector = sector;
            }
            else {
                // If there's nothing left to send this peer then remove
                // this file information.
                delete peerInfo[this.filepath];
            }
        });
    }

    async handleDataPacket(peer, file, index, buffer) {
        if (this.size) {
            ++this.chunkCount[index];
            // If we've already seen this packet then send a control packet
            // and see if we can get the peer to send us packets from another
            // sector of the file.
            if (this.chunkCount[index] > 1) {
                this.sendControlPacket(peer);
            }
            else {
                this.rangeTree.add(index);
                // Copy the data into our file buffer.
                this.bufferView.set(buffer, index * this.fileWorker.mtu);
                // If we have received everything then write the file.
                // TODO - we can start writing the file before we receive the
                // entire file.
                if (this.rangeTree.isComplete()) {
                    let written = 0;
                    while (written < this.size) {
                        written += this.fileAccessHandle.write(buffer, { at: written })
                    }
                    // Done with the access handle!
                    this.fileAccessHandle.close();
                    postMessage({
                        type: 'file',
                        file: this.filepath
                    });
                }
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
        this.rangeTree.generateRange()
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
            }, [data]);
        });
    }

    async sendFilePacket(peer, index) {
        // If there's less the the maximum transmission units left we need to
        // send less then the mtu.
        let size = (index + this.mtu > this.size) ? this.size - index : this.mtu;
        // Create a buffer of the index for copying into the data buffer.
        let dataIndex = new Uint32Array(1);
        dataIndex[0] = index;
        // Create the data buffer.
        let data = new Uint8Array(size+4);
        // Copy the index in first.
        data.set(dataIndex.buffer);
        // Copy the file data in.
        data.set(this.buffer.slice(index, index + size), 4);
        postMessage({
            type: 'send',
            file: this.filepath,
            peer,
            data
        }, [data]);
    }

    async sendFilePackets() {
        this.peers.forEach( (peerInfo, peer) => {
            const fileInfo = peerInfo[this.filepath];
            if (fileInfo) {
                // See if we have a range of chunks to send.
                if (fileInfo.chunks?.length) {
                    fileInfo.nextIndex = fileInfo.chunks[0]++;
                    if (fileInfo.nextIndex > fileInfo.chunks[1]) {
                        chunks.shift();
                        if (fileInfo.chunks.length) {
                            fileInfo.nextIndex = fileInfo.chunks[0]++;
                        }
                        else {
                            // Move onto the next sector and let the other
                            // side send a control packet if they already have
                            // it.
                            fileInfo.nextIndex++;
                            // Wrap around the end of the file.
                            if (fileInfo.nextIndex >= this.size) {
                                fileInfo.nextIndex = 0;
                            }
                        }
                    }
                }
                this.sendFilePacket(peer, fileInfo.nextIndex);
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

    async loadFile(file, filedata) {
        if (!this.files.has(file)) {
            this.files.set(file, new FileHandle(this, file));
        }
        this.files.get(file).loadFile(filedata);
    }

    async handleFileData(peer, file, data) {
        const fileH = this.files.get(file);
        const uint32View = new UInt32Array(data);
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
        case 'init':
            _worker.init(msg.max, msg.mtu, msg.pollingInterval);
            break;
        case 'file':
            return _worker.loadFile(msg.file);
            break;
        case 'data':
            _worker.handleFileData(msg.peer, msg.file, msg.data);
            break;
        case 'upload':
            _worker.loadFile(msg.file, msg.data);
            break;
        default:
            break;
    }
}

