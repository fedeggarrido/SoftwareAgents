import type { IdeaDocumentError } from './messages.js';

/** Shared copy for the office and the local CLI. */
export function ideaDocumentErrorText(code: IdeaDocumentError): string {
  switch (code) {
    case 'document_too_large':
      return 'El documento o su texto extraído supera el límite de 5 MB.';
    case 'unsupported_type':
      return 'Formato no compatible. Adjunta un archivo PDF, MD o TXT.';
    case 'no_text':
      return 'El documento no contiene texto extraíble. Si es un PDF escaneado, conviértelo a texto antes de adjuntarlo.';
    case 'corrupt_file':
      return 'No se pudo leer el documento. Puede estar dañado, protegido con contraseña o tener una codificación distinta de UTF-8.';
    case 'denied':
      return 'Adjuntar documentos requiere acceso del operador humano.';
    case 'unsupported_adapter':
      return 'Adjunta el documento desde la oficina standalone del proyecto.';
    case 'unknown_project':
      return 'El proyecto ha cambiado. Vuelve a abrir Nueva idea.';
    case 'invalid_request':
      return 'El documento recibido no es válido. Selecciona de nuevo el archivo.';
    case 'document_too_long':
      return 'El texto del documento es demasiado largo para revisarlo de una vez (unas 40 páginas). Adjunta solo la parte que describe la idea.';
    case 'reader_unavailable':
      return 'No se pudo resumir el documento con el lector aislado. Comprueba que Claude está disponible y vuelve a adjuntarlo, o escribe la idea con tus palabras.';
    case 'unavailable':
      return 'No se pudo extraer el documento. Comprueba la conexión y vuelve a adjuntarlo.';
  }
}
