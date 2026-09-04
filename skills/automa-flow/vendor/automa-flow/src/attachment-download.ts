export interface AttachmentDownloadInspection {
  directFetch: boolean;
  usesAutomaFetchBase64: boolean;
  risky: boolean;
}

const DIRECT_ATTACHMENT_FETCH_RE =
  /fetch\s*\(\s*(?:await\s+)?(?:attachment|attachments\[[^\]]+\]|item|file|media)\.(?:url|resourceUrl|downloadUrl|previewUrl|thumbnailUrl|src|link)\b/;

const AUTOMA_FETCH_BASE64_RE = /automaFetch\s*\(\s*['"]base64['"]/;

export function inspectAttachmentDownloadCode(code: string): AttachmentDownloadInspection {
  const directFetch = DIRECT_ATTACHMENT_FETCH_RE.test(code);
  const usesAutomaFetchBase64 = AUTOMA_FETCH_BASE64_RE.test(code);
  return {
    directFetch,
    usesAutomaFetchBase64,
    risky: directFetch && !usesAutomaFetchBase64,
  };
}
