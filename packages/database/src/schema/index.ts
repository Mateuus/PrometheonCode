// Schema completo do Hub, organizado pelos grupos do `Docs/07`.
//
// A ordem dos reexports segue a dependência entre os módulos: identidade não
// conhece ninguém, organização conhece identidade, e assim por diante. Isso
// mantém os imports em uma única direção e evita ciclo entre os arquivos.

export * from './columns.js';
export * from './identity.js';
export * from './organization.js';
export * from './integrations.js';
export * from './project.js';
export * from './chat.js';
export * from './orchestration.js';
export * from './knowledge.js';
export * from './governance.js';
export * from './outbox.js';
