# Respuesta del operador a la decisión de diseño de FEAT-001 (2026-10-19)

Los dos intentos se rechazaron por un falso positivo del validador de changeZones
(cualquier zona de directorio se consideraba solapada con el patrón protegido
recursivo `**/.codex/**`). Está corregido en SA-QA-28. Mantén el diseño y las
changeZones propuestas (`webview-ui/test`, `e2e/`, etc.); los ficheros protegidos
se siguen bloqueando fichero a fichero en las guardias. No abras preguntas nuevas
salvo contradicción real.
