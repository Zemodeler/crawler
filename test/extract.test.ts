import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { cachedExtract } from "../src/extract/cache.ts";
import { detectFormat, extractText, htmlToText } from "../src/extract/index.ts";
import { MAX_MEMBER_BYTES, readZipEntries, readZipMember } from "../src/extract/zip.ts";

const fixture = (name: string) => readFile(new URL(`fixtures/extract/${name}`, import.meta.url));
const utf8 = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A ZIP of the given members; deflated unless `stored`. */
function zip(members: Record<string, string>, stored = false): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(members)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const data = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(members).length, 8);
  end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const slide = (...paragraphs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${A} ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${paragraphs
    .map((p) => `<a:p>${p}</a:p>`)
    .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const run = (text: string) => `<a:r><a:rPr lang="en-GB"/><a:t>${text}</a:t></a:r>`;

function pptx(): Uint8Array {
  return zip({
    "[Content_Types].xml": "<Types/>",
    // Presentation order is slide2.xml then slide1.xml: page numbers follow the deck, not the file names.
    "ppt/presentation.xml": `<p:presentation ${P} ${R}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide(run("Coursework &amp; exams"), run("Due week 9") + "<a:br/>" + run("Weight 40%")),
    "ppt/slides/slide2.xml": slide(run("Lecture 1:") + run(" Introduction")),
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide1.xml": `<p:notes ${A} ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p>${run("Remind them about the deadline")}</a:p><a:p><a:fld id="{1}" type="slidenum"><a:t>2</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
  });
}

function docx(): Uint8Array {
  const para = (inner: string) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${inner}</w:p>`;
  const wr = (text: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
  return zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${[
      para(wr("Assessment ") + wr("brief")),
      para(wr("Submit by") + "<w:tab/>" + wr("Friday 4 December 2026, 4pm")),
      para(`<w:r><w:br w:type="page"/></w:r>`),
      para(wr("Marking criteria")),
      `<w:tbl><w:tr><w:tc>${para(wr("Code"))}</w:tc><w:tc>${para(wr("50%"))}</w:tc></w:tr></w:tbl>`,
      para(`<w:del><w:r><w:delText>removed text</w:delText></w:r></w:del>`),
    ].join("")}<w:sectPr/></w:body></w:document>`,
  });
}

function xlsx(): Uint8Array {
  return zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${R}><sheets><sheet name="Deadlines" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Assessment</t></si><si><t>Due</t></si><si><r><t>Essay </t></r><r><rPr><b/></rPr><t>1</t></r><rPh><t>x</t></rPh></si></sst>`,
    "xl/styles.xml": `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="22"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>12</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46340</v></c><c r="C2" s="2"><v>46340.5</v></c></row><row r="3"><c r="A3"/></row></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Late penalty &lt;5%&gt;</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  });
}

test("PDF text comes out per page", async () => {
  const bytes = new Uint8Array(await fixture("handbook.pdf"));
  const doc = await extractText(bytes, "Handbook.pdf");
  assert.equal(doc.format, "pdf");
  assert.equal(doc.sha256, sha256(bytes));
  assert.deepEqual(doc.pages, [
    { page: 1, text: "Module Handbook\nAssessment overview" },
    { page: 2, text: "Coursework 1 is due on 14 November 2026 at 23:59.\nWeight: 30%" },
  ]);
  // The caller's buffer is left intact (pdfjs would otherwise detach it).
  assert.equal(sha256(bytes), doc.sha256);
});

test("PPTX text comes out per slide in deck order, with speaker notes", async () => {
  const doc = await extractText(pptx(), "Week 1.pptx");
  assert.equal(doc.format, "pptx");
  assert.deepEqual(doc.pages, [
    { page: 1, text: "Lecture 1: Introduction" },
    { page: 2, text: "Coursework & exams\nDue week 9\nWeight 40%\n\nNotes:\nRemind them about the deadline" },
  ]);
});

test("DOCX text comes out per paragraph, split at page breaks", async () => {
  const doc = await extractText(docx(), "Brief.docx");
  assert.equal(doc.format, "docx");
  assert.deepEqual(doc.pages, [
    { page: 1, text: "Assessment brief\nSubmit by Friday 4 December 2026, 4pm" },
    { page: 2, text: "Marking criteria\nCode\n50%" },
  ]);
});

test("XLSX text comes out per sheet with shared strings and dates resolved", async () => {
  const doc = await extractText(xlsx(), "Deadlines.xlsx");
  assert.equal(doc.format, "xlsx");
  assert.deepEqual(doc.pages, [
    { page: 1, text: "Assessment\tDue\t12\nEssay 1\t2026-11-14\t2026-11-14 12:00" },
    { page: 2, text: "Late penalty <5%>\tTRUE" },
  ]);
});

test("stored (uncompressed) ZIP members are read too", async () => {
  const bytes = zip({ "word/document.xml": `<w:document ${W}><w:body><w:p><w:r><w:t>Stored</w:t></w:r></w:p></w:body></w:document>` }, true);
  assert.deepEqual((await extractText(bytes, "a.docx")).pages, [{ page: 1, text: "Stored" }]);
});

test("a stored ZIP member over the size cap is refused, like a deflated one", async () => {
  const big = "x".repeat(MAX_MEMBER_BYTES + 1);
  for (const stored of [true, false]) {
    const bytes = zip({ "word/document.xml": big }, stored);
    const entry = readZipEntries(bytes).get("word/document.xml")!;
    assert.throws(() => readZipMember(bytes, entry), stored ? /larger than/ : RangeError);
    assert.deepEqual((await extractText(bytes, "big.docx")).pages, []);
  }
  // At the cap exactly, a stored member is still read.
  const atCap = zip({ "a.txt": "x".repeat(MAX_MEMBER_BYTES) }, true);
  assert.equal(readZipMember(atCap, readZipEntries(atCap).get("a.txt")!).length, MAX_MEMBER_BYTES);
});

test("HTML keeps link targets as 'text (url)'", async () => {
  const html = `<html><head><title>x</title><style>p{}</style></head><body>
    <h2>Coursework</h2><p>Submit via <a href="https://qmplus.qmul.ac.uk/mod/assign/view.php?id=1&amp;a=2">the <b>assignment</b> page</a>
    by <strong>5&nbsp;Dec</strong>.</p><script>alert(1)</script>
    <ul><li>Bare: <a href="https://example.org/x">https://example.org/x</a></li><li><a href="#top">Top</a></li></ul>
    <table><tr><td>Week 9</td><td>Quiz</td></tr></table><!-- hidden --></body></html>`;
  const doc = await extractText(utf8(html), "index.html");
  assert.equal(doc.format, "html");
  assert.deepEqual(doc.pages, [
    {
      page: 1,
      text: "Coursework\nSubmit via the assignment page (https://qmplus.qmul.ac.uk/mod/assign/view.php?id=1&a=2) by 5 Dec.\nBare: https://example.org/x\nTop\nWeek 9 Quiz",
    },
  ]);
  assert.equal(htmlToText("<p>a\n  b</p><p>c<br>d</p>"), "a b\nc\nd");
});

test("format comes from the extension, then the mimetype", async () => {
  assert.deepEqual(detectFormat("Slides.PPTX"), { format: "pptx", readable: true });
  assert.deepEqual(detectFormat("download", "application/pdf"), { format: "pdf", readable: true });
  assert.deepEqual(detectFormat("page", "text/html; charset=utf-8"), { format: "html", readable: true });
  assert.deepEqual(detectFormat("notes.txt"), { format: "text", readable: true });
  assert.deepEqual(detectFormat("photo.jpg", "image/jpeg"), { format: "text", readable: false });
  assert.deepEqual((await extractText(utf8("Line one\r\nLine two\n"), "notes.txt")).pages, [{ page: 1, text: "Line one\nLine two" }]);
  assert.deepEqual((await extractText(new Uint8Array([0xff, 0xd8, 0x00]), "photo.jpg", "image/jpeg")).pages, []);
});

test("corrupt files give no pages and never throw", async () => {
  const junk = utf8("this is not the file you are looking for");
  for (const [name, format] of [
    ["a.pdf", "pdf"],
    ["a.pptx", "pptx"],
    ["a.docx", "docx"],
    ["a.xlsx", "xlsx"],
  ] as const) {
    const doc = await extractText(junk, name);
    assert.equal(doc.format, format);
    assert.deepEqual(doc.pages, []);
    assert.equal(doc.sha256, sha256(junk));
  }
  // A ZIP cut short, and a PDF cut in half.
  assert.deepEqual((await extractText(pptx().subarray(0, 200), "a.pptx")).pages, []);
  const pdf = new Uint8Array(await fixture("handbook.pdf"));
  const half = await extractText(pdf.subarray(0, pdf.length / 2), "a.pdf");
  assert.equal(half.format, "pdf");
  assert.ok(Array.isArray(half.pages));
  // A ZIP without the part the format needs.
  assert.deepEqual((await extractText(zip({ "other.xml": "<x/>" }), "a.docx")).pages, []);
  assert.deepEqual((await extractText(new Uint8Array(0), "a.xlsx")).pages, []);
});

test("cachedExtract stores <stateDir>/text/<sha256>.<format>.json and returns it on a hit", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "crawler-extract-"));
  try {
    const bytes = docx();
    const first = await cachedExtract(stateDir, bytes, "Brief.docx");
    const path = join(stateDir, "text", `${first.sha256}.docx.json`);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), first);
    assert.deepEqual(await readdir(join(stateDir, "text")), [`${first.sha256}.docx.json`]);

    // A hit is served from the file, whatever the filename now says, as long as the format is the same.
    const planted = { ...first, pages: [{ page: 1, text: "from the cache" }] };
    await writeFile(path, JSON.stringify(planted));
    assert.deepEqual(await cachedExtract(stateDir, bytes, "renamed.DOCX"), planted);

    // An unreadable entry is replaced by a fresh extraction.
    await writeFile(path, "{not json");
    assert.deepEqual(await cachedExtract(stateDir, bytes, "Brief.docx"), first);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), first);

    // An entry stored under a different format is not served.
    await writeFile(path, JSON.stringify({ ...first, format: "text" }));
    assert.deepEqual(await cachedExtract(stateDir, bytes, "Brief.docx"), first);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("cachedExtract keys by format: the same bytes as .txt and as .html read differently", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "crawler-extract-"));
  try {
    const bytes = utf8("<p>Due <b>Friday</b></p>");
    const asText = await cachedExtract(stateDir, bytes, "page.txt");
    const asHtml = await cachedExtract(stateDir, bytes, "page.html");
    assert.deepEqual(asText, { sha256: sha256(bytes), format: "text", pages: [{ page: 1, text: "<p>Due <b>Friday</b></p>" }] });
    assert.deepEqual(asHtml, { sha256: sha256(bytes), format: "html", pages: [{ page: 1, text: "Due Friday" }] });
    // Both are now cached, and each hit returns its own format.
    assert.deepEqual(await cachedExtract(stateDir, bytes, "again.txt"), asText);
    assert.deepEqual(await cachedExtract(stateDir, bytes, "download", "text/html"), asHtml);
    assert.deepEqual((await readdir(join(stateDir, "text"))).sort(), [`${sha256(bytes)}.html.json`, `${sha256(bytes)}.text.json`]);
    // An unreadable file is not cached at all.
    assert.deepEqual((await cachedExtract(stateDir, bytes, "photo.jpg", "image/jpeg")).pages, []);
    assert.equal((await readdir(join(stateDir, "text"))).length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("concurrent cachedExtract writes never share a temporary file", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "crawler-extract-"));
  try {
    const bytes = xlsx();
    const results = await Promise.all(Array.from({ length: 20 }, () => cachedExtract(stateDir, bytes, "Deadlines.xlsx")));
    const expected = await extractText(bytes, "Deadlines.xlsx");
    for (const result of results) assert.deepEqual(result, expected);
    // One complete entry and no temporary files left behind.
    assert.deepEqual(await readdir(join(stateDir, "text")), [`${expected.sha256}.xlsx.json`]);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, "text", `${expected.sha256}.xlsx.json`), "utf8")), expected);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
