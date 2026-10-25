// pdf.js, served locally: draws PDFs on phones/tablets where an iframe cannot.
// A file rather than an inline module so the CSP needs no 'unsafe-inline'.
import * as pdfjs from '/vendor/pdfjs/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
window.pdfjsLib = pdfjs;
window.dispatchEvent(new Event('pdfjs-ready'));
