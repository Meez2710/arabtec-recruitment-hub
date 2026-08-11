import fs from 'node:fs';
import { OllamaResumeExtractor } from './src/infrastructure/ai/ollama/ollama-resume-extractor.js';

async function main() {
  console.log('Reading text file...');
  const text = fs.readFileSync('test_cv.txt', 'utf8');
  
  console.log('Extracted text length:', text.length);

  console.log('Extracting resume using Ollama (llama3.2)...');
  const extractor = new OllamaResumeExtractor({ model: 'llama3.2' });
  const result = await extractor.extract({ text, pageCount: 1, pages: [text] });
  
  console.log('Extraction Result:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
