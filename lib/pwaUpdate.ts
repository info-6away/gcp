'use client';

// v11.24.3: tiny module-level singleton so SettingsPanel's
// "Check for Updates" button can reach the active registration without
// prop-drilling through the entire app tree. PWARegister sets the
// reference on register(); SettingsPanel calls checkForUpdate() which
// invokes reg.update() and reports back what happened.

let _registration: ServiceWorkerRegistration | null = null;

export function setRegistration(reg: ServiceWorkerRegistration | null): void {
  _registration = reg;
}

export function getRegistration(): ServiceWorkerRegistration | null {
  return _registration;
}

export type UpdateCheckResult = 'updated' | 'current' | 'unsupported';

// Fire reg.update() and report whether a new SW is now waiting.
//   'updated'      → registration.waiting is set after the update call;
//                    the toast (driven by PWARegister) will surface.
//   'current'      → no waiting worker — already on latest.
//   'unsupported'  → no SW APIs, no registration yet, or update threw.
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return 'unsupported';
  }
  const reg = _registration ?? (await navigator.serviceWorker.getRegistration() ?? null);
  if (!reg) return 'unsupported';
  try {
    console.log('[PWA] manual check for update');
    await reg.update();
    return reg.waiting ? 'updated' : 'current';
  } catch (e) {
    console.warn('[PWA] manual update check failed', e);
    return 'unsupported';
  }
}
