import { run } from './main.ts';

process.exitCode = await run(process.env, { write: (text) => process.stdout.write(text) });
