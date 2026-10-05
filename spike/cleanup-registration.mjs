import { isAbsolute } from 'node:path';
import { removePiRegistration } from '../src/pi-registration.mjs';

const agentDir = process.argv[2];
if (!agentDir || !isAbsolute(agentDir)) {
  console.error('Usage: node spike/cleanup-registration.mjs /absolute/path/to/pi/agent');
  process.exitCode = 2;
} else {
  try {
    const result = await removePiRegistration({ agentDir });
    console.log(`PA BB Pi registration: ${result.status}`);
  } catch {
    // Do not expose arbitrary filesystem/provider error details in BB logs.
    console.error('PA BB Pi registration could not be safely removed; inspect the owned symlink and marker.');
    process.exitCode = 1;
  }
}
