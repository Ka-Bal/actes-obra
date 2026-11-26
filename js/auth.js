// Inici de sessió amb Microsoft (MSAL.js) per accedir a OneDrive amb Microsoft Graph.
// A l'iPad, l'app instal·lada no admet finestres emergents: s'utilitza sempre el flux de redirecció.
import { kv } from './db.js';

let cfgCache = null;
let pca = null;
let account = null;
let initErr = null;

export const SCOPES = ['Files.ReadWrite.All', 'User.Read'];

/** Configuració efectiva: config.js + valors desats a la tauleta (Configuració → OneDrive). */
export async function loadConfig() {
  const base = window.AVENTEC_CONFIG || {};
  const local = (await kv.get('odConfig', {})) || {};
  cfgCache = {
    tenant: 'organizations', rootPath: '02 - EXPEDIENTS - Obra', rootShareUrl: '', graphBase: 'https://graph.microsoft.com/v1.0',
    ...base, ...Object.fromEntries(Object.entries(local).filter(([, v]) => v !== '' && v !== null && v !== undefined)),
    folders: { projecte: '001_Projecte', fotos: '002_Fotos', documents: '003_Documents_obra', ...(base.folders || {}) },
  };
  return cfgCache;
}
export const cfg = () => cfgCache || window.AVENTEC_CONFIG || {};
export const isConfigured = () => !!(cfg().clientId || cfg().testToken);

export class AuthError extends Error {
  constructor(kind, msg) { super(msg || kind); this.kind = kind; }
}

const redirectUri = () => new URL('./', location.href).href.split('#')[0].split('?')[0];

export async function initAuth() {
  await loadConfig();
  const c = cfg();
  if (!c.clientId || c.testToken) return;
  if (!window.msal) { initErr = 'No s\'ha pogut carregar la biblioteca d\'inici de sessió'; return; }
  try {
    pca = new window.msal.PublicClientApplication({
      auth: {
        clientId: c.clientId,
        authority: `https://login.microsoftonline.com/${c.tenant || 'organizations'}`,
        redirectUri: redirectUri(),
        postLogoutRedirectUri: redirectUri(),
        navigateToLoginRequestUrl: false,
      },
      cache: { cacheLocation: 'localStorage' },
    });
    await pca.initialize();
    const res = await pca.handleRedirectPromise();
    if (res && res.account) pca.setActiveAccount(res.account);
    account = pca.getActiveAccount() || pca.getAllAccounts()[0] || null;
    if (account) pca.setActiveAccount(account);
    if (res) history.replaceState(null, '', redirectUri() + (sessionStorage.getItem('aventecReturn') || ''));
  } catch (e) {
    console.error('MSAL', e);
    initErr = e.message;
  }
}

export function accountInfo() {
  if (cfg().testToken) return { name: 'Usuari de prova', username: 'prova@aventec.cat' };
  return account ? { name: account.name, username: account.username } : null;
}
export const authError = () => initErr;

/** Errors de Microsoft (AADSTS…) explicats en paraules senzilles */
export function friendlyAuthError(msg) {
  const m = String(msg || '');
  const uri = redirectUri();
  const table = [
    [/AADSTS50011/, `L'adreça de l'app no està registrada (o no és exactament igual). Al registre de Microsoft, a «Autenticació», hi ha d'haver aquesta adreça com a «Aplicació d'una sola pàgina (SPA)»: ${uri}`],
    [/AADSTS9002326|AADSTS9002327/, `L'adreça s'ha registrat amb la plataforma equivocada («Web»). S'ha de registrar com a «Aplicació d'una sola pàgina (SPA)».`],
    [/AADSTS700016/, `Microsoft no troba l'aplicació: revisa que l'«ID d'aplicació (client)» i l'«ID del directori (tenant)» estiguin ben copiats.`],
    [/AADSTS50194/, `Falta l'«ID del directori (tenant)». Copia'l de la pàgina «Informació general» del registre.`],
    [/AADSTS90002|AADSTS90013/, `L'«ID del directori (tenant)» no és correcte.`],
    [/AADSTS65001|AADSTS90094|AADSTS90008|AADSTS65004/, `Falta el permís de l'administrador. Al registre, a «Permisos d'API», cal prémer «Concedeix el consentiment de l'administrador» (pas 6 de la guia).`],
    [/AADSTS50020|AADSTS500200/, `Aquest compte no és de l'organització on s'ha registrat l'app. Inicia sessió amb el compte de Microsoft 365 d'AVENTEC.`],
    [/AADSTS7000218/, `L'adreça s'ha registrat com a «Web». S'ha de registrar com a «Aplicació d'una sola pàgina (SPA)».`],
    [/user_cancelled|AADSTS65004/, `S'ha cancel·lat l'inici de sessió.`],
  ];
  for (const [re, txt] of table) if (re.test(m)) return txt;
  return m;
}
export const appRedirectUri = () => redirectUri();

/** Obté un testimoni d'accés sense interacció. Llança AuthError('login') si cal tornar a iniciar sessió. */
export async function getToken({ force = false } = {}) {
  const c = cfg();
  if (c.testToken) return c.testToken;
  if (!pca) throw new AuthError('config', initErr || 'OneDrive no està configurat');
  if (!account) throw new AuthError('login', 'Cal iniciar sessió amb Microsoft');
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account, forceRefresh: force });
    return r.accessToken;
  } catch (e) {
    const code = (e && (e.errorCode || e.name)) || '';
    if (e instanceof window.msal.InteractionRequiredAuthError || /interaction_required|login_required|consent_required|no_tokens_found|monitor_window_timeout|token_refresh_required/i.test(code)) {
      throw new AuthError('login', 'La sessió de Microsoft ha caducat: torna a iniciar sessió');
    }
    if (!navigator.onLine || /network|endpoints_resolution|timed_out/i.test(code + ' ' + e.message)) throw new AuthError('offline', 'Sense connexió');
    throw e;
  }
}

export async function login() {
  if (!pca) throw new AuthError('config', initErr || 'Falta configurar l\'ID d\'aplicació (config.js)');
  sessionStorage.setItem('aventecReturn', location.hash || '');
  await pca.loginRedirect({ scopes: SCOPES, prompt: 'select_account' });
}

/** Tanca la sessió només en aquesta tauleta (no a la resta d'apps de Microsoft). */
export async function logout() {
  if (pca && account) { try { await pca.clearCache({ account }); } catch { /* */ } }
  account = null;
}
