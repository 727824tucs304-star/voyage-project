// Reports whether the external AI services are configured. Nothing here pretends a service works.
export function providerStatus() {
  const mock = process.env.TRANSCRIPTION_PROVIDER === 'mock';
  const transcription = mock
    ? { configured: true, provider: 'Test provider (mock)', message: 'Automated tests only. Not a real transcription service.' }
    : process.env.AWS_REGION && process.env.TRANSCRIBE_BUCKET
      ? { configured: true, provider: 'AWS Transcribe', message: 'Credentials and bucket are set. Recordings are transcribed in the background.' }
      : { configured: false, provider: 'AWS Transcribe', message: 'Not configured. Set AWS_REGION and TRANSCRIBE_BUCKET and attach a role with Transcribe and S3 access.' };

  const ai = process.env.AI_PROVIDER === 'mock'
    ? { configured: true, provider: 'Test provider (mock)', message: 'Automated tests only. Not a real AI service.' }
    : process.env.GROQ_API_KEY
      ? { configured: true, provider: 'Groq', message: 'Key is set. Summaries and action items are produced after transcription.' }
      : process.env.GEMINI_API_KEY
        ? { configured: true, provider: 'Google Gemini', message: 'Key is set. Summaries and action items are produced after transcription.' }
        : { configured: false, provider: 'Groq', message: 'Not configured. Set GROQ_API_KEY (free, no card).' };

  return { transcription, ai };
}