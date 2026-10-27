# FEAT-002 · Panel de features en el Command Center

Como operador quiero ver desde el Command Center el estado de las features que el
pipeline está construyendo, para seguir `feature run` sin abrir la terminal.

Mostrar una lista de las features del Project seleccionado con: clave y título,
estado del feature (spec en revisión, aprobado, en diseño, en desarrollo,
ready_to_merge…), progreso de tareas (DONE sobre total) y la tarea en curso con su
paso (develop, review, qa) cuando la haya, gates pendientes que esperan al operador
(aprobación, decisiones, cuota) y la rama de integración cuando exista. Ordenar por
actividad más reciente. Distinguir «sin features» de un fallo de lectura.

La vista es de solo lectura, limitada al Project seleccionado y al ingreso autorizado
existente (mismo privilegio que la vista de auditoría de FEAT-001). No permite
aprobar, responder gates, lanzar ni detener nada en esta primera versión: solo
muestra el comando a ejecutar cuando hay un gate. Reutilizar el WorkStore y los
patrones de la vista de auditoría (protocolo, store sin DOM, panel). No mostrar
prompts, salidas del modelo ni rutas absolutas.

Definir criterios verificables en Given/When/Then y EARS para la lista normal, el
progreso, la tarea en curso, los gates, el estado vacío, el error de lectura y la
separación entre Projects. Escalar en openQuestions solo contradicciones reales.
Esta petición solicita requisitos, sin diseño técnico ni código.
