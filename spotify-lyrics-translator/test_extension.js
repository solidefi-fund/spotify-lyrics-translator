// Test suite for Spotify Lyrics Translator Extension
// Run with: node test_extension.js

const assert = require("assert").strict;

// --- MOCKED/EXTRACTED FUNCTIONS FROM EXTENSION FOR TESTING ---

// 1. LRC Lyrics Parser
function parseLrc(lrcText) {
    const lines = lrcText.split("\n");
    const result = [];
    const timeRegex = /\[(\d+):(\d+)\.(\d+)\]/;
    
    for (const line of lines) {
        const match = timeRegex.exec(line);
        if (match) {
            const min = parseInt(match[1]);
            const sec = parseInt(match[2]);
            const dec = match[3];
            const ms = parseInt(dec) * (dec.length === 2 ? 10 : dec.length === 3 ? 1 : 100);
            const startTimeMs = (min * 60 + sec) * 1000 + ms;
            const words = line.replace(timeRegex, "").trim();
            result.push({ startTimeMs, words });
        } else {
            const cleanWords = line.replace(/\[.*\]/, "").trim();
            if (cleanWords) {
                result.push({ startTimeMs: -1, words: cleanWords });
            }
        }
    }
    return result;
}

// 2. Batch Translation Output Parser
function parseTranslationResponse(translatedText, originalLinesCount) {
    const tLines = translatedText.split("\n");
    const translations = new Array(originalLinesCount).fill(null);
    
    for (const tLine of tLines) {
        let match = /^(\d+)::\s*(.*)$/.exec(tLine.trim());
        if (!match) {
            // Loose matching in case Google Translate altered delimiters
            match = /^(\d+)\s*[:：]+\s*(.*)$/.exec(tLine.trim());
        }
        if (match) {
            const idx = parseInt(match[1]);
            const txt = match[2].trim();
            if (idx >= 0 && idx < originalLinesCount) {
                translations[idx] = txt;
            }
        }
    }
    return translations;
}

// 3. Translation Chunking Calculator (Verification only)
function calculateChunks(lines) {
    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;
    
    lines.forEach((line, idx) => {
        const entryText = `${idx}:: ${line.words}`;
        if (currentLength + entryText.length + 1 > 50) { // Using 50 chars for testing constraint
            chunks.push(currentChunk);
            currentChunk = [ { line, idx } ];
            currentLength = entryText.length;
        } else {
            currentChunk.push({ line, idx });
            currentLength += entryText.length + 1;
        }
    });
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }
    return chunks;
}


// --- TEST CASES ---

function runTests() {
    console.log("Running Lyrics Translator Tests...");

    // Test Case 1: LRC Parser
    console.log(" - Testing LRC parser...");
    const mockLrc = `
[00:01.20] Hello World
[00:15.500] Synced line with 3 decimals
[02:05.02] Third line after two minutes
[invalid] Invalid timestamp line
Unsynced generic line
    `;
    const parsed = parseLrc(mockLrc);
    
    assert.equal(parsed.length, 5, "Should parse exactly 5 lines (3 synced, 2 unsynced)");
    assert.equal(parsed[0].startTimeMs, 1200, "00:01.20 should convert to 1200ms");
    assert.equal(parsed[0].words, "Hello World");
    assert.equal(parsed[1].startTimeMs, 15500, "00:15.500 should convert to 15500ms");
    assert.equal(parsed[2].startTimeMs, 125020, "02:05.02 should convert to 125020ms");
    assert.equal(parsed[3].startTimeMs, -1, "Invalid timestamp line should be treated as unsynced");
    assert.equal(parsed[3].words, "Invalid timestamp line");
    assert.equal(parsed[4].startTimeMs, -1, "Unsynced line should have startTimeMs = -1");
    assert.equal(parsed[4].words, "Unsynced generic line");
    console.log("   ✔ LRC parser tests passed.");

    // Test Case 2: Translation Output Parsing & Alignment
    console.log(" - Testing translation response parsing and alignment...");
    
    // Normal output
    const translatedText1 = "0:: Hello\n1:: Goodbye\n2:: Yes";
    const aligned1 = parseTranslationResponse(translatedText1, 3);
    assert.deepEqual(aligned1, ["Hello", "Goodbye", "Yes"], "Should align simple formats");

    // Loose delimiters due to Google Translate conversions
    const translatedText2 = "0: Hello\n1：Goodbye\n2 :: Yes";
    const aligned2 = parseTranslationResponse(translatedText2, 3);
    assert.deepEqual(aligned2, ["Hello", "Goodbye", "Yes"], "Should align loose formats with full-width colon and spaces");

    // Out-of-order/Missing translations
    const translatedText3 = "2:: Yes\n0:: Hello";
    const aligned3 = parseTranslationResponse(translatedText3, 3);
    assert.deepEqual(aligned3, ["Hello", null, "Yes"], "Should align out-of-order lines and leave missing items as null");
    
    console.log("   ✔ Translation response parser tests passed.");

    // Test Case 3: Chunking Logic
    console.log(" - Testing chunking logic limit thresholds...");
    const mockLines = [
        { words: "Line one" }, // "0:: Line one" -> 11 chars
        { words: "Line two" }, // "1:: Line two" -> 11 chars
        { words: "Line three is much longer than others" }, // "2:: Line three is much longer..." -> 41 chars
        { words: "Short" } // "3:: Short" -> 8 chars
    ];
    // Split constraint is 50 chars in calculateChunks
    const chunks = calculateChunks(mockLines);
    assert.equal(chunks.length, 3, "Should split into exactly 3 chunks due to 50 char mock constraint");
    assert.equal(chunks[0].length, 2, "First chunk should contain 2 short lines");
    assert.equal(chunks[1].length, 1, "Second chunk should contain the single long line");
    assert.equal(chunks[2].length, 1, "Third chunk should contain the final line");
    
    console.log("   ✔ Chunking logic tests passed.");
    
    console.log("\nALL TESTS PASSED SUCCESSFULLY! ✔");
}

try {
    runTests();
} catch (e) {
    console.error("TEST SUITE FAILURE:", e.message);
    process.exit(1);
}
