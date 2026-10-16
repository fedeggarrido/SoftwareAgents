# Respuestas del operador a las openQuestions de FEAT-001

## Ronda 1 (2026-10-16)

1. Consultar la vista NO registra una entrada de auditoría (lectura pura).
2. El log de máquina (projectId nulo) NO se muestra en FEAT-001; queda para una feature posterior.
3. Cargar las últimas 500 entradas con aviso «mostrando las 500 más recientes de N»; paginación real en el futuro.
4. Mostrar status y reason (redactados); el resto de campos de outcome y riskLevel en un detalle plegable. Fecha en hora local del operador con UTC en tooltip.
5. El ingreso autorizado es el existente del Command Center; AC-016 lo reutiliza sin crear permisos nuevos.

## Ronda 2 (2026-10-16)

6. Los filtros de acción y resultado se aplican SOLO a las 500 entradas cargadas, y sus valores salen de ellas; el aviso de truncado ya indica que hay más.
7. El aviso de líneas corruptas y el recuento de entradas excluidas se calculan sobre TODO el archivo, no solo la ventana de 500.
8. Formato de fecha local fijo `AAAA-MM-DD HH:mm:ss` (independiente del locale); el tooltip muestra el mismo instante en UTC con el mismo formato y sufijo `UTC`.

Con estas respuestas el alcance de FEAT-001 queda cerrado: no abras preguntas nuevas salvo contradicción real.
