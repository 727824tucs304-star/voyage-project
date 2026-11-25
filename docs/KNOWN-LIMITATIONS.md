# Known limitations

## Product
- The AI analysis is a draft. It can be wrong or incomplete; the professional must review it against the recording.
- The free AI tier limits how much can be analysed per minute and per day (about 8,000 tokens per minute and 200,000 per day for the model in use). Long meetings take longer; very heavy use can be refused for the rest of the day.
- Free-tier transcription quality depends on the audio. Background noise and overlapping speakers reduce accuracy.
- There is no "forgot password" by email. An administrator resets passwords.
- Word downloads are HTML-based documents, not native .docx files.
- Recordings are removed only when the meeting or recording is deleted. There is no automatic retention policy yet.

## Platform
- The site runs on HTTP. HTTPS needs a custom domain.
- One server hosts all customers. A server failure stops every workspace until it is recovered.
- Backups on the server are kept for 3 days; the copy in S3 is kept for 30 days.
- Customer and admin rate limits reset when the control plane restarts.

## Testing
- The 93 automated checks use stand-ins for Docker, GitHub and AWS commands.
- No browser-based end-to-end test suite has been written.

## Security
- No independent penetration test or certification.
- The control plane uses the Docker socket, which gives effectively root access on the host.
