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

class ScatteredRangeRedBlackTree {
    constructor(size) {
        this._root = null;
        this._lastIndex = size - 1;
        this._queue = [];
    }

    async add(index) {
        const insert = async addIndex => {
            if (!this._root) {
                return this.createNode(null, addIndex);
            }
            return this.addRange(this._root, addIndex)
        };
        return Promise.resolve(this._queue.push(index))
        .then( async newLength => {
            if (newLength === 1) {
                var currentIndex;
                do {
                    currentIndex = this._queue[0];
                    await insert(currentIndex).then( newRoot => {
                        while(newRoot.parent) {
                            newRoot = newRoot.parent;
                        }
                        // Root node is never red.
                        newRoot.red = false;
                        this._root = newRoot;
                    });
                    this._queue.shift();
                } while (this._queue.length);
            }
            return Promise.resolve({});
        });
    }

    async generateAvailableIndexes(peerRangeList) {
        return this.generateRangeForNode(this._root)
        .then( rangeList => {
            var currentRange;
            let remoteRange = peerRangeList.shift();
            let resultList = [];
            // Iterate our list.
            while (rangeList.length && remoteRange) {
                currentRange = rangeList.shift();
                // Move up the peer list until we find one that overlaps.
                while (remoteRange && currentRange[0] > remoteRange[1]) {
                    remoteRange = peerRangeList.shift();
                }
                // Make sure we still have one.
                if (remoteRange) {
                    // Check if anything comes before the remote range.
                    if (currentRange[0] < remoteRange[0]) {
                        resultList.push([currentRange[0], remoteRange[0]-1]);
                    }
                    // Check if anything comes after the remote range.
                    if (currentRange[1] > remoteRange[1]) {
                        let start = remoteRange[1]+1;
                        remoteRange = peerRangeList.shift();
                        // Work our way through the remote range list until we
                        // reach the other end of our range.
                        while (remoteRange && remoteRange[0] < currentRange[1]) {
                            // Add a range that starts from the last remote
                            // range until the current remote range.
                            resultList.push([start, remoteRange[0]-1]);
                            // Start the start of the next range.
                            start = remoteRange[1]+1;
                            remoteRange = peerRangeList.shift();
                        }
                        // Add the remaining range based on the current range.
                        resultList.push([start, currentRange[1]]);
                    }
                }
                // If we ran out of range objects from the peer list then push
                // the currentRange onto the list.
                else {
                    resultList.push(currentRange);
                }
            }
            // Anything left over in our list can be pushed on the end.
            resultList.push(...rangeList);
            return Promise.resolve(resultList);
        });
    }

    // Returns a boolean to indicate it all indexes are accounted for.
    isComplete() {
        const root = this._root;
        return !!root &&
               root.range[0] === 0 &&
               root.range[1] === this._lastIndex;
    }

    static test() {
        function generateRanges(rangeList) {
            return rangeList.map( range => {
                let results = [];
                for(let i=range[0];i<=range[1];++i) {
                    results.push(i);
                }
                return results;
            }).flat();
        }
        function generateRandomOrder(size) {
            var i;
            let results = [];
            for (i=0;i<size;++i) {
                results.push(i);
            }
            for (i=0;i<size;++i) {
                let swapIndex = Math.floor(Math.random() * size);
                let value = results[i];
                results[i] = results[swapIndex];
                results[swapIndex] = value;
            }
            return results;
        }
        function runCompleteRangeTest(name, source) {
            return Promise.resolve(new ScatteredRangeRedBlackTree(source.length))
            .then( tree => {
                return Promise.all(source.map(index => tree.add(index)))
                .then( results => {
                    return tree.isComplete();
                })
                .then( complete => {
                    console.log(name, complete ? 'success' : 'fail');
                    return Promise.all([Promise.resolve(name), Promise.resolve(complete)]);
                });
            })
            .catch( err => {
                console.error('range test failure: ' + name, err);
                return Promise.resolve([name, false]);
            });
        }
        function runAvailableIndexesTest(name, source, size, peerRangeList, expectedAnswer) {
            return Promise.resolve(new ScatteredRangeRedBlackTree(size))
            .then( tree => {
                return Promise.all(source.map(index => tree.add(index)))
                .then( results => {
                    return tree.generateAvailableIndexes(peerRangeList)
                    .then( availableIndexes => {
                        return Promise.all([
                            Promise.resolve(name),
                            new Promise( (resolve, reject) => {
                                let ok = availableIndexes.length === expectedAnswer.length;
                                if (ok) {
                                    for(let i=0;i<availableIndexes.length;++i) {
                                        ok &&= (availableIndexes[i][0] === expectedAnswer[i][0] && availableIndexes[i][1] === expectedAnswer[i][1]);
                                    }
                                }
                                console.log(name, ok ? 'success' : 'fail');
                                resolve(ok);
                            })
                        ]);
                    });
                });
            })
            .catch( err => {
                console.error('available index test failure: ' + name, err);
                return Promise.resolve([name, false]);
            });
        }
        Promise.all([
            runCompleteRangeTest('order', [0,1,2,3,4,5,6,7,8,9]),
            runCompleteRangeTest('backwards', [9,8,7,6,5,4,3,2,1,0]),
            runCompleteRangeTest('mix odds evens', [5,3,7,9,1,2,8,4,6,0]),
            runCompleteRangeTest('odds then evens', [1,3,5,7,9,2,4,6,8,0]),
            runCompleteRangeTest('events then odds', [8,6,4,2,0,9,7,5,3,1]),
            runCompleteRangeTest('random order set of 10', generateRandomOrder(10)),
            runCompleteRangeTest('random order set of 100', generateRandomOrder(100)),
            runCompleteRangeTest('random order set of 1000', generateRandomOrder(1000)),
            runCompleteRangeTest('random order set of 10000', generateRandomOrder(10000)),
            runCompleteRangeTest('random order set of 20000', generateRandomOrder(20000)),
            runCompleteRangeTest('random order set of 30000', generateRandomOrder(30000)),
            runCompleteRangeTest('random order set of 40000', generateRandomOrder(40000)),
            runCompleteRangeTest('random order set of 50000', generateRandomOrder(50000)),
            runCompleteRangeTest('random order set of 100000', generateRandomOrder(100000)),
            runAvailableIndexesTest('split answer', generateRanges([[0,100]]), 101, [[50,59]], [[0,49],[60,100]]),
            runAvailableIndexesTest('multiple splits', generateRanges([[0,100]]), 101, [[20,29],[50,59]], [[0,19],[30,49],[60,100]]),
            runAvailableIndexesTest('narrowed', generateRanges([[20,29],[40,49]]), 101, [[20,29],[50,59]], [[40,49]]),
            runAvailableIndexesTest('nothing', generateRanges([[20,29],[40,49]]), 101, [[20,29],[40,49]], []),
            runAvailableIndexesTest('one', generateRanges([[20,29],[40,49]]), 101, [[20,28],[40,49]], [[29,29]]),
            runAvailableIndexesTest('overlap', generateRanges([[50,100]]), 101, [[0,75],[80,85]], [[76,79],[86,100]]),
            runAvailableIndexesTest('after', generateRanges([[90,100]]), 101, [[50,59]], [[90,100]]),
        ]);
    }

    async addRange(node, index) {
        var searchIndex, secondSearchIndex, direction;
        // Go left.
        if (index < node.range[0]) {
            searchIndex = index + 1;
            secondSearchIndex = index - 1;
            direction = 0;
        }
        // Go right.
        else if (index > node.range[1]) {
            searchIndex = index - 1;
            secondSearchIndex = index + 1;
            direction = 1;
        }
        // The index is already included keep the root.
        else {
            return Promise.resolve(node);
        }
        // Check if this index increases the range for this node.
        if (node.range[direction] === searchIndex) {
            node.range[direction] = index;
            return this.findSuccessor(node, direction)
            .then( async successor => {
                // Check if the successor has the second search index.
                if (successor && successor.range[1-direction] === secondSearchIndex) {
                    let toDelete = successor;
                    node.range[direction] = successor.range[direction];
                    // It's easier to delete a leaf node, so we will find a
                    // successor to the node we want to delete until we run
                    // out of successors.
                    while (toDelete.children[0] || toDelete.children[1]) {
                        // If there's a child then there's a successor.
                        toDelete = await this.findSuccessor(toDelete, direction);
                        // Copy the range from the new successor into the
                        // previous one.
                        successor.range = toDelete.range;
                        // Set the successor to this new node and make sure it
                        // does not have a sucessor of its own.
                        successor = toDelete;
                    }
                    // Delete the leaf node.
                    return this.delete(toDelete);
                }
                // We only increased the range of a single node.
                return Promise.resolve(node.parent??node);
            });
        }
        // If this node has a child in the direction we are interested
        // in then recurse the tree.
        if (node.children[direction]) {
            return this.addRange(node.children[direction], index)
            .then( newRoot => {
                return Promise.resolve(node.parent??node);
            });
        }
        // Create a new node and add it.
        return this.createNode(node, index)
        .then( newNode => {
            node.children[direction] = newNode;
            return this.fixInsert(newNode);
        });
    }

    createNode(node, index) {
        return Promise.resolve({
            range: [index, index],
            red: true,
            parent: node,
            children: [null, null]
        });
    }

    async delete(node) {
        const direction = node.parent.children[0] === node ? 0 : 1;
        const otherDirection = 1 - direction;
        const originalParent = node.parent;
        const sibling = node.parent.children[otherDirection];
        // Remove the leaf.
        originalParent.children[direction] = null;
        // If the node we deleted is red we don't need to do anything.
        if (!node.red) {
            return this.fixDelete(node.parent, otherDirection);
        }
        // This is harmless if nothing changed.
        return Promise.resolve(originalParent);
    }

    // Finds the in-order successor.
    async findSuccessor(node, direction) {
        const otherDirection = 1 - direction;
        if (node.children[direction]) {
            node = node.children[direction];
            while (node.children[otherDirection]) {
                node = node.children[otherDirection];
            }
            return Promise.resolve(node);
        }
        return Promise.resolve(null);
    }

    async fixDelete(node, siblingSide) {
        return Promise.resolve(node.children[siblingSide])
        .then( sibling => {
            // If the sibling is red then rotate.
            const far = sibling?.children[siblingSide];
            const near = sibling?.children[1-siblingSide];
            if (sibling?.red || far?.red) {
                return this.rotate(node, 1-siblingSide);
            }
            else if (near?.red) {
                return this.rotate(sibling, siblingSide)
                .then( newSibling => {
                    return this.rotate(node, node.children[0] === newSibling ? 1 : 0);
                });
            }
            if (node.parent) {
                // Recolour the sibling.
                if (sibling) {
                    sibling.red = true;
                }
                return this.fixDelete(node.parent, node.parent.children[0] === node ? 0 : 1);
            }
            return Promise.resolve(node);
        });
    }

    async fixInsert(node) {
        return Promise.resolve(node.parent?.red).then( redParent => {
            // If we accidentally made the root node red we'll fix it in add()
            if (redParent && node.parent.parent) {
                const parentSide = node.parent.parent.children[0] === node.parent ? 0 : 1;
                const uncleSide = node.parent.children[0] === node ? 1 : 0;
                const uncle = node.parent.children[uncleSide];
                if (uncle?.red) {
                    node.red = false;
                    node.parent.red = true;
                    uncle.red = false;
                    return this.fixInsert(node.parent);
                }
                else {
                    if (uncleSide === parentSide) {
                        return this.rotate(node.parent, uncleSide);
                    }
                    else {
                        return this.rotate(node.parent.parent, 1-parentSide);
                    }
                }
            }
            return Promise.resolve(node.parent);
        });
    }

    generateRange() {
        return this.generateRangeForNode(this._root);
    }

    // Recurse the left side then right to generate the list.
    generateRangeForNode(node) {
        if (!node) { return Promise.resolve([]); }
        return this.generateRangeForNode(node.children[0]).then( results => {
            results.push(node.range.slice());
            return this.generateRangeForNode(node.children[1]).then( rightList => {
                results.push(...rightList);
                return Promise.resolve(results);
            });
        });
    }

    // Rotates around the given node based on the given direction.
    // right = 1, left = 0
    rotate(node, direction) {
        return new Promise( (resolve, reject) => {
            const wasRed = node.red;
            const otherDirection = 1 - direction;
            const newRoot = node.children[otherDirection];
            const otherChild = newRoot.children[direction];
            node.children[otherDirection] = otherChild;
            if (otherChild) {
                newRoot.children[direction].parent = node;
            }
            if (node.parent) {
                node.parent.children[node.parent.children[0] === node ? 0 : 1] = newRoot;
            }
            newRoot.children[direction] = node;
            newRoot.parent = node.parent;
            node.parent = newRoot;
            node.red = newRoot.red;
            newRoot.red = wasRed;
            resolve(newRoot);
        });
    }

    setFull() {
        if (this._root) {
            return Promise.reject(new Error('Cannot set partial file to full'));
        }
        return this.createNode(null, 0)
        .then( root => {
            this._root = root;
            this._root.red = false;
            this._root.range[1] = this._lastIndex;
            return Promise.resolve(true);
        });
    }
}

