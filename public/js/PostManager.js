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

class PostManager {
    constructor(postsElem,
                postTemplateElem,
                pictureTemplateElem,
                videoTemplateElem,
                commentTemplateElem,
                textTemplateElem,
                formTemplateElem) {
        this.postsElem = postsElem;
        this.postTemplateElem = postTemplateElem;
        this.pictureTemplateElem = pictureTemplateElem;
        this.videoTemplateElem = videoTemplateElem;
        this.commentTemplateElem = commentTemplateElem;
        this.textTemplateElem = textTemplateElem;
        this.formTemplateElem = formTemplateElem;
    }

    getPost(postId) {
        let postElem = document.getElementById(postId);
        if (!postElem) {
            postElem = this.postTemplateElem.cloneNode(true);
            postElem.id = postId;
            this.postsElem.appendChild(postElem);
        }
        return postElem;
    }

    addImage(filepath, fileext, data) {
        let parts = filepath.split('/').slice(4);
        let elemId = parts.shift();
        let post = this.getPost(elemId);
        let contentsElem = post.querySelector('[name="contents"]');
        let newImage = this.pictureTemplateElem.cloneNode(true);
        let imgElements = newImage.getElementsByTagName('img');
        for (const img of imgElements) {
            img.src = URL.createObjectURL(new Blob([data], { type: 'image/' + fileext }));
        }
        contentsElem.appendChild(newImage);
    }

    addVideo() {
        let parts = filepath.split('/').slice(4);
        let elemId = parts.shift();
        let post = this.getPost(elemId);
        let contentsElem = post.querySelector('[name="contents"]');
        let newVideo = this.videoTemplateElem.cloneNode(true);
        let videoElements = newVideo.getElementsByTagName('video');
        for (const video of videoElements) {
            video.src = URL.createObjectURL(new Blob([data], { type: 'video/' + fileext }));
            video.load();
        }
        contentsElem.appendChild(newImage);
    }

    addComment(filepath, text) {
    }

    addForm() {
    /*
        let formElements = newImage.getElementsByTagName('form');
        for (const form of formElements) {
            const submitButton = form.querySelector('input[type="submit"]');
            submitButton.addEventListener('click', ev => {
                ev.preventDefault();
                const ts = Date.now();
                const filename = filepath.slice(0, filepath.lastIndexOf('/') + 1) + ts + '/' + ts + '.txt';
                const formData = new FormData(form);
                const encoder = new TextEncoder();
                const comment = encoder.encode(formData.get('comment'));
                this.loadSharedFile(filename, comment)
                .then( result => {
                    this.fileWorker.postMessage({ request: 'create', file: filename, data: comment });
                });
            });
        }
     */
    }
}

