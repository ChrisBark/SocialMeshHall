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
                textTemplateElem,
                formTemplateElem) {
        this.postsElem = postsElem;
        this.postTemplateElem = postTemplateElem;
        this.pictureTemplateElem = pictureTemplateElem;
        this.videoTemplateElem = videoTemplateElem;
        this.textTemplateElem = textTemplateElem;
        this.formTemplateElem = formTemplateElem;
    }

    #commentsSelector = '[name="comments"]';
    #contentsSelector = '[name="contents"]';

    addPost(filepath, data) {
        let parts = filepath.split('/')
        let parentElem = this.postsElem;
        var elemId, post, newContent, contentsElem;
        let postFilepath = parts.slice(0,4).join('/');
        parts = parts.slice(4);
        // Use the last directory as the id for this file.
        while (parts.length > 1) {
            elemId = parts.shift();
            postFilepath += '/' + elemId;
            post = this.#getPost(elemId, parentElem, postFilepath);
            parentElem = post.querySelector(parts.length > 1 ? this.#commentsSelector : this.#contentsSelector);
        }
        const fileext = filepath.split('.').pop().toLowerCase();
        var newContent;
        switch(fileext) {
            case 'png':
            case 'bmp':
            case 'gif':
                newContent = this.createImage(fileext, data);
                break;
            case 'jpeg':
            case 'jpg':
                newContent = this.createImage('jpeg', data);
                break;
            case 'svg':
                newContent = this.createImage('svg+xml', data);
                break;
            case 'mp4':
            case 'wemb':
                newContent = this.createVideo(fileext, data);
                break;
            case 'txt':
                newContent = this.createText(filepath, (new TextDecoder()).decode(data));
                break;
            default:
                break;
        }
        if (newContent) {
            this.#appendPost(parentElem, newContent);
        }
    }

    #appendPost(parentElem, newElem) {
        var sibling;
        for (const node of parentElem.childNodes) {
            if (node.id > newElem.id || node.id === 'formTemplate') {
                sibling = node;
            }
        }
        parentElem.insertBefore(newElem, sibling);
    }

    #getPost(postId, parentElem, postFilepath) {
        var postElem;
        try {
            postElem = parentElem.querySelector('#P' + postId);
        }
        catch (err) {
            console.error(err);
        }
        if (!postElem) {
            postElem = this.postTemplateElem.cloneNode(true);
            postElem.id = 'P' + postId;
            let commentsElem = postElem.querySelector(this.#contentsSelector);
            this.addForm(commentsElem, postFilepath);
            this.#appendPost(parentElem, postElem);
        }
        return postElem;
    }

    createImage(fileext, data) {
        let newImage = this.pictureTemplateElem.cloneNode(true);
        let imgElements = newImage.getElementsByTagName('img');
        for (const img of imgElements) {
            img.src = URL.createObjectURL(new Blob([data], { type: 'image/' + fileext }));
        }
        return newImage;
    }

    createVideo(fileext, data) {
        let newVideo = this.videoTemplateElem.cloneNode(true);
        let videoElements = newVideo.getElementsByTagName('video');
        for (const video of videoElements) {
            video.src = URL.createObjectURL(new Blob([data], { type: 'video/' + fileext }));
            video.load();
        }
        return newVideo;
    }

    createText(filepath, text) {
        let newComment = this.textTemplateElem.cloneNode(true);
        let textElements = newComment.getElementsByTagName('p');
        for (const textElem of textElements) {
            textElem.textContent = text;
        }
        return newComment;
    }

    addForm(parentElem, postFilepath) {
        let newForm = this.formTemplateElem.cloneNode(true);
        let formElements = newForm.getElementsByTagName('form');
        for (const formElem of formElements) {
            const submitButton = formElem.querySelector('input[type="submit"]');
            submitButton.addEventListener('click', ev => {
                ev.preventDefault();
                const now = new Date();
                const ts = now.getTime();
                const formData = new FormData(formElem);
                const encoder = new TextEncoder();
                const comment = encoder.encode(formData.get('comment'));
                let files = formData.get('files');
                if (!Array.isArray(files)) {
                    if (files.name) {
                        files = [ files ];
                    }
                    else {
                        files = null;
                    }
                }
                if (!postFilepath) {
                    const year = now.getUTCFullYear();
                    const month = now.getUTCMonth();
                    const date = now.getUTCDate();
                    postFilepath = `/${year}/${month}/${date}/${ts}/`;
                }
                else {
                    if (!postFilepath.endsWith('/')) {
                        postFilepath += '/';
                    }
                    postFilepath += (ts + '/');
                }
                if (comment.length) {
                    this.fileMgr.shareText(postFilepath + ts + '.txt', comment);
                }
                if (files) {
                    this.fileMgr.shareFiles(postFilepath, files);
                }
            });
        }
        parentElem.appendChild(newForm);
    }
}

