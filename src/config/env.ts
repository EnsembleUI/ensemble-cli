const DEFAULT_FIREBASE_PROJECT = 'ensemble-web-studio';
const DEFAULT_AUTH_BASE_URL = 'https://studio.ensembleui.com/sign-in';
const DEFAULT_FIREBASE_API_KEY = '__ENSEMBLE_FIREBASE_API_KEY__';

export function getEnsembleFirebaseProject(): string {
  return process.env.ENSEMBLE_FIREBASE_PROJECT ?? DEFAULT_FIREBASE_PROJECT;
}

export function getEnsembleAuthBaseUrl(): string {
  return process.env.ENSEMBLE_AUTH_BASE_URL ?? DEFAULT_AUTH_BASE_URL;
}

export function getEnsembleFirebaseApiKey(): string | undefined {
  return process.env.ENSEMBLE_FIREBASE_API_KEY ?? DEFAULT_FIREBASE_API_KEY;
}

