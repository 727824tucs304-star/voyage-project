// Reports whether the external AI services are configured. Nothing here pretends a service works.
export function providerStatus() {
  const transcription = process.env.AWS_REGION && process.env.TRANSCRIBE_BUCKET
    ? { configured: true, provider: 'AWS Transcribe', message: 'Credentials and bucket are set. Transcription runs once the processing worker is enabled.' }
    : { configured: false, provider: 'AWS Transcribe', message: 'Not configured. Set AWS_REGION and TRANSCRIBE_BUCKET and attach a role with Transcribe and S3 access.' };
  const ai = process.env.OPENAI_API_KEY
    ? { configured: true, provider: 'OpenAI', message: 'API key is set. Analysis runs once the processing worker is enabled.' }
    : { configured: false, provider: 'OpenAI', message: 'Not configured. Set OPENAI_API_KEY.' };
  return { transcription, ai };
}
