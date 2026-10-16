# FEAT-001 · Vista de auditoría del Command Center

Como operador de un Managed Project quiero consultar su audit log desde el
Command Center para entender quién solicitó cada acción, qué decidió la política
y cuál fue el resultado.

Mostrar fecha, actor, acción, recurso, resultado y referencias de Task/Execution
cuando existan. Permitir filtrar por acción y resultado, ordenar del más reciente
al más antiguo y distinguir datos ausentes de un fallo de lectura. Si no hay
entradas, mostrar un estado vacío claro. Las líneas corruptas no deben ocultar
las demás entradas.

La vista es de solo lectura, limitada al Project seleccionado y al ingreso
autorizado existente. No mostrará secretos ni permitirá cambiar, borrar o fabricar
entradas. No incluir exportación, cambios de retención ni nuevos permisos en esta
primera versión. Usar la auditoría y la redacción existentes.

Definir criterios verificables en Given/When/Then y EARS para lectura normal,
filtros, estado vacío, datos corruptos y separación entre Projects. Escalar en
openQuestions cualquier contradicción de producto que no pueda resolverse con
este alcance. Esta petición solicita requisitos, sin diseño técnico ni código.
