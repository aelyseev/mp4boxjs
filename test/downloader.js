import {ContentAddressableStorage} from './ca.js';
import {TESTNET} from './ddc-client.js';

console.log({ContentAddressableStorage});

function computeWaitingTimeFromBuffer(v) {
    var ms = v.ms;
    var sb;
    var startRange, endRange;
    var currentTime = v.currentTime;
    var playbackRate = v.playbackRate;
    var maxStartRange = 0;
    var minEndRange = Infinity;
    var ratio;
    var wait;
    var duration;
    /* computing the intersection of the buffered values of all active sourcebuffers around the current time,
       may already be done by the browser when calling video.buffered (to be checked: TODO) */
    for (var i = 0; i < ms.activeSourceBuffers.length; i++) {
        sb = ms.activeSourceBuffers[i];
        for (var j = 0; j < sb.buffered.length; j++) {
            startRange = sb.buffered.start(j);
            endRange = sb.buffered.end(j);
            if (currentTime >= startRange && currentTime <= endRange) {
                if (startRange >= maxStartRange) maxStartRange = startRange;
                if (endRange <= minEndRange) minEndRange = endRange;
                break;
            }
        }
    }
    if (minEndRange === Infinity) {
        minEndRange = 0;
    }
    duration = minEndRange - maxStartRange;
    ratio = (currentTime - maxStartRange) / duration;
    console.debug('Demo', `Playback position (${Log.getDurationString(currentTime)}) in current buffer [${Log.getDurationString(maxStartRange)}, ${Log.getDurationString(minEndRange)}]: ${Math.floor(ratio * 100)}%`);
    if (ratio >= 3 / (playbackRate + 3)) {
        console.debug("Demo", "Downloading immediately new data!");
        /* when the currentTime of the video is at more than 3/4 of the buffered range (for a playback rate of 1),
           immediately fetch a new buffer */
        return 1; /* return 1 ms (instead of 0) to be able to compute a non-infinite bitrate value */
    } else {
        /* if not, wait for half (at playback rate of 1) of the remaining time in the buffer */
        wait = 1000 * (minEndRange - currentTime) / (2 * playbackRate);
        console.debug('Demo', `Waiting for ${Log.getDurationString(wait, 1000)} s for the next download`);
        return wait;
    }
}

export class Downloader {
    /**
     * @type {bigint}
     */
    bucketId = 0n;
    isActive = false;
    chunkStart = 0;
    /**
     * @type {number}
     */
    chunkSize = 0;
    totalLength = 0;
    url = null;
    callback = null;
    eof = false;
    downloadTimeoutCallback = null;
    cache = new Map();

    constructor(bucketId, cid) {
        this.bucketId = bucketId;
        this.mainPiece = ContentAddressableStorage.build({clusterAddress: 2, smartContract: TESTNET})
            .then(storage => {
                this.storage = storage;
                return storage.read(bucketId, cid);
            });
    }

    setup(mainPiece) {
        const [firstLink] = mainPiece.links;
        this.links = mainPiece.links;
        this.totalLength = this.links.reduce((acc, link) => acc + Number(link.size), 0);
        this.setChunkSize(Number(firstLink.size));
    }

    async getPiece(cid) {
        if (this.cache.has(cid)) {
            return this.cache.get(cid);
        }
        const piece = await this.storage.read(this.bucketId, cid);
        this.cache.set(cid, piece);
        return piece;
    }

    setDownloadTimeoutCallback(callback) {
        this.downloadTimeoutCallback = callback;
        return this;
    }

    reset() {
        this.chunkStart = 0;
        this.totalLength = 0;
        this.eof = false;
        return this;
    }

    setRealTime() {
        return this;
    }

    setChunkSize(_size) {
        this.chunkSize = _size;
        return this;
    }

    setChunkStart(_start) {
        this.chunkStart = _start;
        this.eof = false;
        return this;
    }

    setInterval(_timeout) {
        return this;
    }

    setUrl(_url) {
        this.url = _url;
        return this;
    }

    setCallback(_callback) {
        this.callback = _callback;
        return this;
    }

    isStopped() {
        return !this.isActive;
    }

    getFileLength() {
        return this.totalLength;
    }

    getFile() {
        const dl = this;
        if (dl.totalLength && this.chunkStart >= dl.totalLength) {
            dl.eof = true;
        }
        if (dl.eof === true) {
            console.debug("Downloader", "File download done.");
            this?.callback?.(null, true);
            return;
        }
        let range = null;
        let maxRange;
        if (this.chunkStart + this.chunkSize < Infinity) {
            range = `bytes=${this.chunkStart}-`;
            maxRange = this.chunkStart + this.chunkSize - 1;
            range += maxRange;
        }

        const [requestId] = crypto.getRandomValues(new Uint32Array([1]));
        const headers = range ? {Range: range} : {};

        fetch(this.url, {headers})
            .then(response => {
                const rangeReceived = response.headers.get('Content-Range');
                console.log({rangeReceived, range, requestId});
                console.debug("Downloader", "Received data range: " + rangeReceived);
                if (!dl.totalLength && rangeReceived) {
                    let sizeIndex = rangeReceived.indexOf("/");
                    if (sizeIndex > -1) {
                        dl.totalLength = Number(rangeReceived.slice(sizeIndex + 1));
                    }
                }
                return response.arrayBuffer();
            })
            .then(buffer => {
                buffer.fileStart = this.chunkStart;
                dl.callback(buffer, dl.eof);
                if (dl.isActive === true && dl.eof === false) {
                    let timeoutDuration = computeWaitingTimeFromBuffer(document.getElementById('v'));
                    console.debug('Downloader', `Next download scheduled in ${Math.floor(timeoutDuration)} ms.`);
                    dl.timeoutID = window.setTimeout(dl.getFile.bind(dl), timeoutDuration);
                } else {
                    dl.isActive = false;
                }
            })
            .catch((err) => {
                console.log({range, err, requestId});
                dl.callback(null, false, true);
            })
    }

    start() {
        console.debug("Downloader", "Starting file download");
        this.chunkStart = 0;
        this.resume();
        return this;
    }

    resume() {
        console.debug("Downloader", "Resuming file download");
        this.isActive = true;
        if (this.chunkSize === 0) {
            this.chunkSize = Infinity;
        }
        this.getFile();
        return this;
    }

    stop() {
        console.debug("Downloader", "Stopping file download");
        this.isActive = false;
        if (this.timeoutID) {
            window.clearTimeout(this.timeoutID);
            delete this.timeoutID;
        }
        return this;
    }
}
