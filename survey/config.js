/* Survey settings. Edit before deploying. */
window.SURVEY_CONFIG = {
  // Where to send submissions automatically.
  //   'netlify'  use Netlify Forms (survey must be hosted on Netlify)
  //   'auto'     use Netlify Forms when hosted on *.netlify.app, otherwise none
  //   ''         no automatic sending; the customer downloads the JSON and emails it
  remote: 'auto',
  // Optional: any HTTPS endpoint that accepts a JSON POST (used when remote is '' or fails).
  endpoint: '',
  // Shown to the customer as the address to email the file to.
  contactEmail: 'arno.van.huyssteen@adroitconsult.eu',
  // Upload limits
  maxFiles: 12,
  maxImageEdge: 1600,
  maxFileBytes: 3 * 1024 * 1024
};
