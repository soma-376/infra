import { runWriter, safeErrorCode, validateConfig, WriterError } from './index.mjs';
import { createSecretReader } from './sdk.mjs';

let reader;
try {
  let raw;
  try { raw = JSON.parse(process.env.JWT_WRITER_CONFIG ?? ''); }
  catch { throw new WriterError('CONFIG_INVALID'); }
  const config = validateConfig(raw);
  reader = createSecretReader(config.region);
  await runWriter(config, reader);
} catch (error) {
  process.stderr.write(`${safeErrorCode(error)}\n`);
  process.exitCode = 1;
} finally {
  reader?.destroy();
}
