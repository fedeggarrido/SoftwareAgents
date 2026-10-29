# FEAT-003 · Coste por feature en el panel de features

Como operador quiero ver en el panel de features del Command Center cuánto ha costado
cada feature, para comparar features y detectar las que se han encarecido sin abrir
la terminal ni ejecutar `pixel-agents usage`.

En cada fila del panel de features (FEAT-002) mostrar, a partir del ledger de uso
(SA-037) y solo de las ejecuciones de esa feature: coste estimado en USD, número de
ejecuciones, cuántas de ellas tienen coste conocido (cobertura, porque las ejecuciones
históricas sin registro no lo tienen), coste por tarea terminada (DONE) y tasa de
acierto de caché. Cuando no haya ningún dato de coste mostrar «sin datos», nunca 0.
Las cifras se leen en el mismo snapshot de solo lectura del panel; no añadir otra
consulta ni escrituras.

La vista sigue siendo de solo lectura, limitada al Project seleccionado y al mismo
ingreso autorizado del panel. No mostrar prompts, salidas del modelo, precios de la
configuración ni rutas absolutas. Reutilizar la proyección del panel, el contrato
`featuresSnapshot` y los agregados del ledger existentes.

Definir criterios verificables en Given/When/Then y EARS para: fila con coste
conocido, cobertura parcial, sin datos de coste, coste por tarea terminada sin
tareas DONE, y que una feature nunca muestre ejecuciones de otra ni de otro Project.
Escalar en openQuestions solo contradicciones reales. Esta petición solicita
requisitos, sin diseño técnico ni código.
