export function OnboardingModule() {
  return (
    <div className="module-container">
      <h1>Ajuda</h1>
      <div className="desk-grid">
        <section className="card guide-content">
          <h2>Leitor de código de barras</h2>
          <p>Conecte o leitor por USB ou Bluetooth no modo teclado. Configure o sufixo como Enter ou Tab e use a tela Teste de leitor para conferir a leitura antes de iniciar o recebimento.</p>
        </section>
        <section className="card guide-content">
          <h2>Instalar no celular</h2>
          <p>No Chrome para Android, use a opção de instalar o aplicativo. No Safari para iPhone, toque em Compartilhar e depois em Adicionar à Tela de Início.</p>
          <p>Permita o acesso à câmera para fotografar etiquetas. Mantenha o aplicativo aberto ao sincronizar as fotos.</p>
        </section>
      </div>
    </div>
  )
}
