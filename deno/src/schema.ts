import z from 'zod';
import { ExcludeConfigSchema, ReposConfigSchema } from './types.ts';

await Deno.writeTextFile('exclude.schema.json', JSON.stringify(z.toJSONSchema(ExcludeConfigSchema)));
await Deno.writeTextFile('repos.schema.json', JSON.stringify(z.toJSONSchema(ReposConfigSchema)));
