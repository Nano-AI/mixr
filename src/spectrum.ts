import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';

const projectId = process.env.PROJECT_ID;
const projectSecret = process.env.PROJECT_SECRET;
if (!projectId || !projectSecret) {
  console.error('Spectrum requires PROJECT_ID and PROJECT_SECRET in .env.');
  process.exit(1);
}

// Never include credentials or message contents in operational errors.
function reportError(context: string, error: unknown) {
  const detail = error instanceof Error ? error.message : 'Unknown error';
  console.error(`${context}: ${detail.replaceAll(projectSecret!, '[redacted]')}`);
}

try {
  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
    options: { logLevel: 'info' },
  });

  const stop = async () => {
    console.info('Stopping Spectrum.');
    await app.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.info('Spectrum connected; iMessage handler waiting for inbound messages.');

  for await (const [space, message] of app.messages) {
    if (message?.direction === 'outbound') continue;
    if (message?.platform !== 'imessage' || message?.content?.type !== 'text') continue;
    if (typeof message.content.text !== 'string' || !message.sender?.id) {
      console.warn('Ignored text event without valid text or sender.');
      continue;
    }
    console.info('Inbound iMessage text received and parsed.');
    try {
      await space.send(`Photon Spectrum is connected. You said: ${message.content.text}`);
      console.info('Photon accepted the reply.');
    } catch (error) {
      reportError('Reply failed', error);
    }
  }
} catch (error) {
  reportError('Spectrum startup or subscription failed', error);
  process.exitCode = 1;
}
