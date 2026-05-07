import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config";
import { getCurrentCompanyId } from "../company-context";
import { readEnvFile, toMap } from "./envFile";
import { telegramApi } from "./notifications";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const STATUS_CACHE_MS = 60_000;

type TranscriptionErrorKind = "missing_key" | "invalid_key" | "telegram_download" | "ffmpeg" | "openai" | "empty_transcript";

export class TelegramVoiceTranscriptionError extends Error {
  constructor(public kind: TranscriptionErrorKind, message: string) {
    super(message);
  }
}

export interface TelegramTranscriptionStatus {
  configured: boolean;
  valid: boolean;
  model: string;
  source: "root-env";
  checkedAt: number | null;
  error?: string;
}

interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

interface TranscriptionCredentials {
  apiKey: string | null;
  model: string;
}

const statusCache = new Map<number, { keyFingerprint: string; model: string; checkedAt: number; status: TelegramTranscriptionStatus }>();

export async function getTelegramTranscriptionStatus(): Promise<TelegramTranscriptionStatus> {
  const credentials = await readTranscriptionCredentials();
  if (!credentials.apiKey) {
    return {
      configured: false,
      valid: false,
      model: credentials.model,
      source: "root-env",
      checkedAt: Date.now(),
      error: "OPENAI_API_KEY is missing from the active company root .env",
    };
  }

  const keyFingerprint = fingerprint(credentials.apiKey);
  const companyId = getCurrentCompanyId();
  const cached = statusCache.get(companyId);
  if (
    cached
    && cached.keyFingerprint === keyFingerprint
    && cached.model === credentials.model
    && Date.now() - cached.checkedAt < STATUS_CACHE_MS
  ) {
    return cached.status;
  }

  const checkedAt = Date.now();
  const status = await validateOpenAiKey(credentials.apiKey, credentials.model, checkedAt);
  statusCache.set(companyId, { keyFingerprint, model: credentials.model, checkedAt, status });
  return status;
}

export async function transcribeTelegramVoice(input: {
  botToken: string;
  fileId: string;
}): Promise<string> {
  const credentials = await readTranscriptionCredentials();
  if (!credentials.apiKey) {
    throw new TelegramVoiceTranscriptionError("missing_key", "OPENAI_API_KEY is missing from the active company root .env");
  }

  const audio = await downloadTelegramFile(input.botToken, input.fileId);
  const wav = await convertTelegramVoiceToWav(audio);
  const transcript = await transcribeAudio(credentials.apiKey, credentials.model, wav);
  const clean = transcript.trim();
  if (!clean) {
    throw new TelegramVoiceTranscriptionError("empty_transcript", "OpenAI returned an empty transcription");
  }
  return clean;
}

export function telegramVoiceTranscriptionErrorMessage(error: unknown): string {
  if (error instanceof TelegramVoiceTranscriptionError) {
    if (error.kind === "missing_key") {
      return "Voice transcription is not configured. Add OPENAI_API_KEY to the active company root .env, then try again.";
    }
    if (error.kind === "invalid_key") {
      return "Voice transcription failed because the OpenAI API key is not valid. Update OPENAI_API_KEY in the active company root .env.";
    }
    if (error.kind === "telegram_download") {
      return `Voice transcription failed while downloading the Telegram audio: ${error.message}`;
    }
    if (error.kind === "ffmpeg") {
      return `Voice transcription failed while converting the audio with ffmpeg: ${error.message}`;
    }
    if (error.kind === "empty_transcript") {
      return "Voice transcription finished, but no speech was detected.";
    }
    return `Voice transcription failed at OpenAI: ${error.message}`;
  }
  return `Voice transcription failed: ${String((error as any)?.message || error)}`;
}

async function readTranscriptionCredentials(): Promise<TranscriptionCredentials> {
  const entries = await readEnvFile(join(config.repoDir, ".env"));
  const env = toMap(entries);
  const apiKey = (env.OPENAI_API_KEY || "").trim() || null;
  const model = (env.AIOS_TELEGRAM_TRANSCRIBE_MODEL || process.env.AIOS_TELEGRAM_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIPTION_MODEL).trim()
    || DEFAULT_TRANSCRIPTION_MODEL;
  return { apiKey, model };
}

async function validateOpenAiKey(apiKey: string, model: string, checkedAt: number): Promise<TelegramTranscriptionStatus> {
  try {
    const response = await fetch(`${OPENAI_MODELS_URL}/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) {
      return { configured: true, valid: true, model, source: "root-env", checkedAt };
    }
    const detail = await openAiError(response, "OpenAI API key validation failed");
    return { configured: true, valid: false, model, source: "root-env", checkedAt, error: detail };
  } catch (e: any) {
    return {
      configured: true,
      valid: false,
      model,
      source: "root-env",
      checkedAt,
      error: String(e?.message || e),
    };
  }
}

async function downloadTelegramFile(botToken: string, fileId: string): Promise<Buffer> {
  let file: TelegramFile;
  try {
    file = await telegramApi<TelegramFile>(botToken, "getFile", { file_id: fileId });
  } catch (e: any) {
    throw new TelegramVoiceTranscriptionError("telegram_download", String(e?.message || e));
  }

  if (!file.file_path) {
    throw new TelegramVoiceTranscriptionError("telegram_download", "Telegram did not return a file path");
  }

  try {
    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim());
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (e: any) {
    throw new TelegramVoiceTranscriptionError("telegram_download", String(e?.message || e));
  }
}

async function convertTelegramVoiceToWav(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "aios-telegram-voice-"));
  const inputPath = join(dir, "voice.ogg");
  const outputPath = join(dir, "voice.wav");
  try {
    await writeFile(inputPath, input);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (e) => reject(new TelegramVoiceTranscriptionError("ffmpeg", e.message)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf-8").trim();
      reject(new TelegramVoiceTranscriptionError("ffmpeg", detail || `ffmpeg exited with code ${code}`));
    });
  });
}

async function transcribeAudio(apiKey: string, model: string, audio: Buffer): Promise<string> {
  const form = new FormData();
  form.append("model", model);
  form.append("response_format", "text");
  form.append("file", new Blob([audio], { type: "audio/wav" }), "voice.wav");

  const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (response.ok) return (await response.text()).trim();

  const detail = await openAiError(response, "OpenAI transcription failed");
  const kind = response.status === 401 ? "invalid_key" : "openai";
  throw new TelegramVoiceTranscriptionError(kind, detail);
}

async function openAiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: any = await response.json();
    return payload?.error?.message || payload?.message || `${fallback} (${response.status})`;
  } catch {
    const text = (await response.text().catch(() => "")).trim();
    return text || `${fallback} (${response.status})`;
  }
}

function fingerprint(value: string): string {
  return `${value.length}:${value.slice(0, 8)}:${value.slice(-4)}`;
}
