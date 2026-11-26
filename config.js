// Configuració de la connexió amb OneDrive (Microsoft 365).
// Només cal editar aquest fitxer un cop, en publicar l'app. Vegeu README.md, apartat «Connexió amb OneDrive».
window.AVENTEC_CONFIG = {
  // ID d'aplicació (client) de l'app registrada a Microsoft Entra ID (portal Azure → Registres d'aplicacions)
  clientId: '',

  // 'organizations' = comptes de Microsoft 365 d'empresa; o l'ID del tenant d'AVENTEC; 'common' admet també comptes personals
  tenant: 'organizations',

  // Carpeta general dels expedients, dins del OneDrive de l'usuari
  rootPath: '02 - EXPEDIENTS - Obra',

  // Opcional: enllaç de la carpeta general si és una carpeta compartida per un altre usuari o d'una biblioteca de
  // SharePoint/Teams (OneDrive → carpeta → Comparteix → Copia l'enllaç). Si s'omple, té prioritat sobre rootPath.
  rootShareUrl: '',

  // Subcarpetes de cada expedient
  folders: {
    projecte: '001_Projecte',        // documents i plànols de projecte (el despatx → la tauleta)
    fotos: '002_Fotos',              // fotos de les visites (la tauleta → OneDrive)
    documents: '003_Documents_obra', // full de visita, plànols anotats, àudios, dades (la tauleta → OneDrive)
  },

  graphBase: 'https://graph.microsoft.com/v1.0',
};
