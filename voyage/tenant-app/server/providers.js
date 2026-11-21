// Reports whether the external AI services are configured. Nothing here pretends a service works.
export function providerStatus() {
  const mock = process.env.TRANSCRIPTION_PROVIDER === 'mock';
  const transcription = mock
    ? { configured: true, provider: 'Test provider (mock)', message: 'Automated tests only. Not a real transcription service.' }
    : process.env.AWS_REGION && process.env.TRANSCRIBE_BUCKET
      ? { configured: true, provider: 'AWS Transcribe', message: 'Credentials and bucket are set. Recordings are transcribed in the background.' }
      : { configured: false, provider: 'AWS Transcribe', message: 'Not configured. Set AWS_REGION and TRANSCRIBE_BUCKET and attach a role with Transcribe and S3 access.' };
  const ai = process.env.OPENAI_API_KEY
    ? { configured: true, provider: 'OpenAI', message: 'API key is set. Analysis runs once the processing worker is enabled.' }
    : { configured: false, provider: 'OpenAI', message: 'Not configured. Set OPENAI_API_KEY.' };
  return { transcription, ai };
}
