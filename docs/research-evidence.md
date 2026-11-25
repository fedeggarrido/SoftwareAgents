# Research: importancia y podcasts (SA-106)

El modelo marca `important` en afirmaciones determinantes para decisiones,
recomendaciones o riesgos significativos. El runtime exige dos fuentes independientes
para ellas con la heurística existente: extractos y dominios distintos, y autor/canal
distinto cuando ambos se conocen. Si faltan, fija confianza baja y añade una laguna
de evidencia insuficiente, incluso si el modelo ya declaró baja. Esta heurística
no garantiza independencia editorial ni verdad. Una sola fuente sigue en baja.
La importancia la declara el modelo: si no la marca, no se añade la laguna, aunque la
confianza baja por falta de fuentes se aplica siempre.
El campo es opcional: ausente significa no importante. No se reescriben informes
guardados; la comprobación se aplica al validar o preparar el handoff.

`--kinds podcast --source https://editor.example/feed.xml` admite el RSS público
del editor. No añade servicios de descubrimiento: el operador aporta feeds que
ya acepte la política HTTP(S) pública existente. No cambia hosts, claves,
dependencias, variables de entorno, puertos ni scripts requeridos.

El adapter usa researchHttp y el plazo global de researchPolicy. Lee metadatos de
episodios y, si el feed declara `<podcast:transcript>` con tipo text/plain o
text/vtt, su texto público. Conserva hasta 4000 caracteres por episodio; sin
transcripción compatible usa la descripción. No descarga audio, no scrapea páginas
ni consulta directorios. No admite transcripciones JSON/HTML. Rechaza DTD y
declaraciones de entidades. Cada descarga conserva el límite de 1 MiB, 10 s y las
guardas SSRF y de redirección existentes. Si una transcripción falla o no es
válida, ese episodio conserva su descripción precedida de «Transcript unavailable».

La declaración del feed indica procedencia del editor, sin autenticar titularidad
ni veracidad. Feeds o transcripciones que requieran acceso o redirecciones no
admitidas no estarán disponibles. Los tests usan fixtures e HTTP inyectado, sin red.
