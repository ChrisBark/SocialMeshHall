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

class FileSectorSelector {
    constructor(numChunks, numSectors) {
        this.numSectors = parseInt(numSectors);
        this.numChunks = parseInt(numChunks);
        this.chunksPerSector = this.numChunks/this.numSectors;
        this.sectorLoad = (new Array(this.numSectors)).fill().map(n => new Set);
        this.sectorBoundaries = [];
        // Generate the sector boundaries.
        // We need the floor of the chunks per sector.
        let cpsFloor = Math.floor(this.chunksPerSector);
        // Also track the remaining chunks.
        let remaining = this.numChunks - (cpsFloor * this.numSectors);
        let start = 0;
        var end;
        for(let i=0;i<this.numSectors;++i) {
            // If we have less chunks then sectors in this file then we want
            // to break out early.
            if (cpsFloor === 0 && i >= remaining) break;
            end = start + cpsFloor - 1;
            // Split the remaining over enough of the sectors to cover the
            // additional chunks.
            if (i<remaining) {
                ++end;
            }
            this.sectorBoundaries.push([start, end]);
            start = end + 1;
        }
    }

    selectSector(rangeList, peerInfo, currentSector) {
        // Create a new sector detail list.
        return Promise.resolve((new Array(this.numSectors)).fill().map(n => { return {count:0, chunks:[]};}))
        .then( sectorDetailList => {
            // Fill in the details. Count how many chunks within the sector is
            // needed and track the ranges needed for each sector.
            var index, firstSector, lastSector, end, sectorEnd, start, sectorBoundary;
            rangeList.forEach( range => {
                // Use the first value in the range to calculate the first
                // sector this range covers.
                start = range[0];
                firstSector = this.sectorBoundaries.findIndex( _sectorBoundary => start >= _sectorBoundary[0] && start <= _sectorBoundary[1]);
                // Use the second value to calculate the last sector.
                end = range[1];
                lastSector = this.sectorBoundaries.findIndex( _sectorBoundary => end >= _sectorBoundary[0] && end <= _sectorBoundary[1]);
                if (firstSector >= 0 && lastSector < this.numSectors) {
                    // Iterate from the first to last calculated sectors.
                    for (index = firstSector;index<=lastSector;index++) {
                        sectorBoundary = this.sectorBoundaries[index];
                        if (!sectorBoundary) {
                            console.log('sector boundary problem', firstSector, lastSector, index, range, JSON.stringify(rangeList));
                            continue;
                        }
                        // Calculate the start and end of this sector within the
                        // range.
                        start = sectorBoundary[0] > range[0] ? sectorBoundary[0] : range[0];
                        end = sectorBoundary[1] < range[1] ? sectorBoundary[1] : range[1];
                        // Fill the sector details we'll use to calculate scores.
                        sectorDetailList[index].count += (end - start + 1);
                        sectorDetailList[index].chunks.push([start,end]);
                    }
                }
                else {
                    console.log('invalid range', range, firstSector, lastSector, JSON.stringify(rangeList));
                }
            });
            return Promise.resolve(sectorDetailList);
        })
        .then( sectorDetailList => {
            // Calculate a score based on how many packets from that part
            // this peer needs and the number of peers that are receiving
            // packets from that part and then sort the chunks using those
            // scores..
            const selected = sectorDetailList
            .map( (sectorDetails, index) => {
                return {
                    score: (this.chunksPerSector - this.sectorLoad[index].size) * sectorDetails.count,
                    chunks: sectorDetails.chunks,
                    index
                };
            })
            // Descending order of score.
            .sort((a,b) => {
                // If they have the same score then randomly decide the order.
                if (a.score === b.score) {
                    return Math.random() - 0.5;
                }
                return b.score - a.score
            });
            let result = null;
            // If the first item in the list has a score then there are chunks
            // to send.
            if (selected[0].score) {
                const sector = selected[0].index;
                this.sectorLoad[sector].add(peerInfo);
                let i=0;
                let chunks = [];
                // Add the chunks from any other sectors that have a non-zero
                // score.
                while(selected[i]?.score) {
                    chunks.push(...selected[i++].chunks);
                }
                if (chunks.length) {
                    result = { sector, chunks };
                }
            }
            if (currentSector !== undefined) {
                this.sectorLoad[currentSector].delete(peerInfo);
            }
            // Nothing to send.
            return Promise.resolve(result);
        });
    }
}

