/** npm run check:ai   one tiny real request with made-up data, to see that the AI key works. */
import { db } from '../src/lib/db';
import { env } from '../src/lib/env';
import { llmJson, objectSchema } from '../src/lib/llm';

async function main() {
  const p = env().LLM_PROVIDER;
  if (p === 'mock') throw new Error('LLM_PROVIDER is still mock in .env. Set it to groq first.');
  const t = Date.now();
  const r = await llmJson({
    operation: 'check',
    system: 'Answer with one JSON object: {"greeting": string}',
    prompt: 'Write a polite one-line greeting to Professor Example.',
    schema: objectSchema({ greeting: 'string' }),
    mock: () => ({}),
  });
  console.log(`${p} works (${Date.now() - t} ms):`, r);
}

main()
  .catch((e) => {
    console.error('AI check failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
