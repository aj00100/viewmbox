// public/workers/mbox-worker.js
// High-Performance Streaming Chunked MBOX Indexer & Message Parser
// Hardened for 10GB+ Google Takeout, Thunderbird & Apple Mail archives

self.onmessage = async function(e) {
  const { type, file, offset, length } = e.data;

  if (type === 'INDEX_FILE') {
    await indexMboxFile(file);
  } else if (type === 'READ_MESSAGE') {
    await readSingleMessage(file, offset, length);
  }
};

/**
 * Decodes MIME encoded-words (RFC 2047) e.g., =?UTF-8?B?...?= or =?ISO-8859-1?Q?...?=
 * Prevents raw gibberish in sidebar list.
 */
function decodeRFC2047(str) {
  if (!str || !str.includes('=?')) return str ? str.trim() : '';
  return str.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        const binStr = atob(text.replace(/\s/g, ''));
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        return new TextDecoder(charset).decode(bytes);
      } else if (encoding.toUpperCase() === 'Q') {
        const qp = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        const bytes = new Uint8Array(qp.length);
        for (let i = 0; i < qp.length; i++) bytes[i] = qp.charCodeAt(i);
        return new TextDecoder(charset).decode(bytes);
      }
    } catch {
      return text;
    }
    return text;
  }).trim();
}

/**
 * Streams through multi-GB MBOX file in 16MB chunks with a 64-byte overlap,
 * identifying valid From_ boundaries and indexing Subject, From, Date headers.
 */
async function indexMboxFile(file) {
  const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB chunk
  const OVERLAP = 64; // Prevents boundary split bug
  const totalSize = file.size;

  const messageIndex = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  // Strict RFC 4155 / Google Takeout From_ regex
  // Requires: From <caller-id> <day-of-week> <month> <day> <hh:mm:ss>
  // Prevents false splits on body text starting with "From what I remember..."
  const FROM_REGEX = /(?:^|\r?\n)(From\s+[^\r\n]+\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}[^\r\n]*)/g;

  let lastReportedProgress = 0;

  try {
    let currentSliceStart = 0;

    while (currentSliceStart < totalSize) {
      const sliceEnd = Math.min(totalSize, currentSliceStart + CHUNK_SIZE + OVERLAP);
      const sliceBlob = file.slice(currentSliceStart, sliceEnd);
      const arrayBuffer = await sliceBlob.arrayBuffer();
      const textChunk = decoder.decode(arrayBuffer);

      let match;
      while ((match = FROM_REGEX.exec(textChunk)) !== null) {
        const matchIndexInChunk = match.index;
        const isByteZero = (currentSliceStart === 0 && matchIndexInChunk === 0);
        
        let actualMatchOffset = matchIndexInChunk;
        if (!isByteZero) {
          if (match[0].startsWith('\r\n')) actualMatchOffset += 2;
          else if (match[0].startsWith('\n')) actualMatchOffset += 1;
        }

        const globalOffset = currentSliceStart + actualMatchOffset;

        // Skip duplicates if landing inside overlap window
        if (messageIndex.length > 0 && globalOffset <= messageIndex[messageIndex.length - 1].offset) {
          continue;
        }

        // Update previous message length
        if (messageIndex.length > 0) {
          const prev = messageIndex[messageIndex.length - 1];
          prev.length = globalOffset - prev.offset;
        }

        // Extract first ~2KB for headers
        const headerSnippet = textChunk.slice(actualMatchOffset, actualMatchOffset + 2048);
        const subjectMatch = headerSnippet.match(/(?:\r?\n|^)Subject:\s*([^\r\n]+)/i);
        const fromMatch = headerSnippet.match(/(?:\r?\n|^)From:\s*([^\r\n]+)/i);
        const dateMatch = headerSnippet.match(/(?:\r?\n|^)Date:\s*([^\r\n]+)/i);

        messageIndex.push({
          id: messageIndex.length,
          offset: globalOffset,
          length: 0,
          subject: subjectMatch ? decodeRFC2047(subjectMatch[1]) : '(No Subject)',
          from: fromMatch ? decodeRFC2047(fromMatch[1]) : 'Unknown Sender',
          date: dateMatch ? dateMatch[1].trim() : ''
        });
      }

      currentSliceStart += CHUNK_SIZE;

      // Progress reporting
      const percent = Math.min(100, Math.round((currentSliceStart / totalSize) * 100));
      if (percent - lastReportedProgress >= 5 || currentSliceStart >= totalSize) {
        lastReportedProgress = percent;
        self.postMessage({
          type: 'INDEX_PROGRESS',
          percent,
          indexedCount: messageIndex.length,
          bytesScanned: Math.min(totalSize, currentSliceStart)
        });
      }
    }

    // Set last message length
    if (messageIndex.length > 0) {
      const last = messageIndex[messageIndex.length - 1];
      last.length = totalSize - last.offset;
    }

    self.postMessage({
      type: 'INDEX_COMPLETE',
      totalCount: messageIndex.length,
      index: messageIndex
    });

  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      message: err.message || 'Error scanning MBOX file'
    });
  }
}

/**
 * Loads a single email on demand by slicing exact byte boundaries.
 */
async function readSingleMessage(file, offset, length) {
  try {
    const blob = file.slice(offset, offset + length);
    const buffer = await blob.arrayBuffer();
    self.postMessage({
      type: 'MESSAGE_LOADED',
      offset,
      buffer
    }, [buffer]); // Zero-copy Transferable
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      message: err.message || 'Error reading message from disk'
    });
  }
}
