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
    case 'unavailable':
      return 'No se pudo extraer el documento. Comprueba la conexión y vuelve a adjuntarlo.';
  }
}
