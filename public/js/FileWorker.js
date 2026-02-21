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
        this.pollH = setInterval(this.sendFilePackets.bind(this), fileWorker.pollingInterval);
        this.ctrlPacketThrottle = {};
        this.ctrlPacketRetry = {};
    }

    async getFileHandle(create) {
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
            return p.then( dh => dh.getDirectoryHandle(v, {create}));
        }, navigator.storage.getDirectory())
        .then( dh => dh.getFileHandle(fileName, {create}));
    }

    async write(data) {
        return new Promise( (resolve, reject) => {
            this.getFileHandle(true)
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
            console.error('load file error', err);
        });
    }

    async create(data) {
        return this.write(data)
        .then( sizeChanged => {
            this.rangeTree.setFull();
            // Trigger a swarm for the new file.
            this.swarm();
            return Promise.resolve(sizeChanged);
        });
    }

    open(peer) {
        return Promise.resolve(!this.buffer)
        .then( noBuffer => {
            if (noBuffer) {
                // Try and open the file without creating it.
                return this.getFileHandle(false)
                .then( fh => {
                    return fh.getFile();
                })
                .then( file => {
                    return file?.arrayBuffer();
                })
                .then( fileBuffer => {
                    if (fileBuffer) {
                        return this.setSize(fileBuffer.byteLength, fileBuffer);
                    }
                    return Promise.resolve(false);
                })
                .then( sizeChanged => {
                    if (sizeChanged) {
                        this.rangeTree.setFull();
                    }
                    // We don't need to trigger a swarm if someone asked for a
                    // file we have and didn't create.
                    return Promise.resolve(false);
                })
                .catch(err => {
                    return Promise.resolve(true);
                });
            }
            // If we are asked to open a file then we only want to trigger a
            // swarm if it is an incomplete file.
            return Promise.resolve(!this.rangeTree?.isComplete());
        })
        .then( swarm => {
            // If we don't have the complete file then start a swarm.
            if (swarm) {
                this.swarm();
            }
            // If we know the size of this file then just send a control
            // packet 
            if (peer && this.size) {
                return this.sendControlPacket(peer);
            }
        });
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
                this.chunkCount = (new Array(size)).fill(filedata?1:0);
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
        let otherSideComplete = false;
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
                    if (_peer !== peer) {
                        this.sendControlPacket(_peer).catch( err => {
                            console.error('Error sending control packet to peer', _peer, err);
                        });
                    }
                });
            }
            let rangeList = [];
            // Determine what they need.
            for(let i=1;i<buffer.length/2;i++) {
                rangeList.push([buffer[i*2], buffer[(i*2)+1]]);
            }
            // Determine if the other side has the entire file.
            otherSideComplete = rangeList.length === 1 &&
                                rangeList[0][0] === 0 &&
                                rangeList[0][1] === (this.numChunks - 1);
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
                peerInfo[this.filepath].currentSector = null;
                // If there is nothing to send, but the file hasn't been
                // completely received then try again.
                if (otherSideComplete && this.rangeTree?.isComplete()) {
                    postMessage({
                        type: 'close',
                        file: this.filepath,
                        peer: peer
                    });
                }
                else if (!this.rangeTree?.isComplete()) {
                    // If the other side has the complete file then don't wait.
                    if (otherSideComplete) {
                        this.sendControlPacket(peer).catch(err => {
                            console.error('Failed to renegotiate with control packet', err);
                        });
                    }
                    // If the other side doesn't have the complete file then
                    // wait a few seconds and try again.
                    else if (!this.ctrlPacketRetry[peer]) {
                        this.ctrlPacketRetry[peer] = setTimeout(() => {
                            this.ctrlPacketRetry[peer] = null;
                            this.sendControlPacket(peer).catch(err => {
                                console.error('Timeout failed to send control packet', err);
                            });
                        }, Math.floor(Math.random()*5000)+5000);
                    }
                }
            }
        });
    }

    async handleDataPacket(peer, file, index, buffer) {
        if (index >= this.numChunks) {
            console.error('got index ' + index + ' with only ' + this.numChunks + ' chunks expected');
            return;
        }
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
                // Copy the data into our file buffer.
                this.bufferView.set(buffer, index * this.fileWorker.mtu);
                // Now add the index to the range tree.
                this.rangeTree.add(index)
                .then( ignore => {
                    // If we have received everything then write the file.
                    // TODO - we can start writing the file before we receive the
                    // entire file.
                    if (this.rangeTree.isComplete()) {
                        return this.write(this.buffer)
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
        if (!this.ctrlPacketThrottle[peer]) {
            this.ctrlPacketThrottle[peer] = {count: 0};
        }
        // We limit how many control packets we send out in a given time
        // period with a throttle.
        if (this.ctrlPacketThrottle[peer].timeout) {
            ++this.ctrlPacketThrottle[peer].count;
            return Promise.resolve(true);
        }
        // Create a throttle timer for this peer.
        this.ctrlPacketThrottle[peer].timeout = setTimeout(() => {
            this.ctrlPacketThrottle[peer].timeout = null;
            // Only call sendControlPacket if someone tried to send it while
            // the throttle was active.
            if (this.ctrlPacketThrottle[peer].count) {
                this.ctrlPacketThrottle[peer].count = 0;
                this.sendControlPacket(peer);
            }
        }, Math.floor(Math.random()*1000)+1000);
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
        const packetStart = this.fileWorker.mtu * index;
        // If there's less the the maximum transmission units left we need to
        // send less then the mtu.
        let size = ((this.fileWorker.mtu * (index + 1)) > this.size) ? this.size % this.fileWorker.mtu
                                                                     : this.fileWorker.mtu;
        // Create the data buffer.
        let data = new Uint8Array(size+4);
        // Create a buffer of the index for copying into the data buffer.
        const dataView = new DataView(data.buffer);
        // Copy the index in first.
        dataView.setUint32(0, index, true);
        // Copy the file data in.
        data.set(new Uint8Array(this.buffer.slice(packetStart, packetStart + size)), 4);
        // Send the data.
        postMessage({
            type: 'send',
            file: this.filepath,
            peer,
            data
        });
    }

    async sendFilePackets() {
        (this.fileWorker?.peers??[]).forEach( (peerInfo, peer) => {
            // Grab the current sector information for this file.
            const fileInfo = peerInfo[this.filepath];
            const sector = fileInfo?.currentSector;
            if (sector) {
                // See if we have a range of chunks to send.
                if (sector.chunks?.length) {
                    // Increment the start of the first entry in the
                    // range list, but use the value form before the
                    // increment.
                    let nextIndex = sector.chunks[0][0]++;
                    // Compare the calculated index against the end of the
                    // first entry in the range list.
                    if (nextIndex > sector.chunks[0][1]) {
                        // If we've exhausted that range then discare the
                        // first entry in the range list.
                        sector.chunks.shift();
                        // If there are any more chunks then move onto the
                        // next chunk.
                        if (sector.chunks.length) {
                            nextIndex = sector.chunks[0][0]++;
                        }
                        else {
                            // We may be done. Trigger a control packet to
                            // help determine if we are done.
                            return this.sendControlPacket(peer).catch(err => {
                                console.error('Failed to send control packet', err);
                            });
                        }
                    }
                    // Just in case we somehow end up with an index that is
                    // out of range.
                    if (nextIndex < this.numChunks && this.chunkCount[nextIndex]) {
                        this.sendFilePacket(peer, nextIndex);
                    }
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
        return this.files.get(file).create(data);
    }

    async open(peer, file) {
        if (!this.files.has(file)) {
            this.files.set(file, new FileHandle(this, file));
        }
        if (!this.peers.has(peer)) {
            this.peers.set(peer, {});
        }
        return this.files.get(file).open(peer);
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
        // Use a data view to extract the index.
        const dataView = new DataView(data);
        const index = dataView.getUint32(0, true);
        // In case data arrives early.
        if (!this.peers.has(peer)) {
            this.peers.set(peer, {});
        }
        if (index === 0xFFFFFFFF) {
            return fileH.handleControlPacket(peer, file, new Uint32Array(data.slice(4)));
        }
        else {
            return fileH.handleDataPacket(peer, file, index, new Uint8Array(data.slice(4)));
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

