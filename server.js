const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xml2js = require('xml2js');
const pdfParse = require('pdf-parse');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Inicializar banco de dados
const db = new sqlite3.Database('./commission.db', (err) => {
  if (err) {
    console.error('Erro ao abrir banco de dados:', err);
  } else {
    console.log('Banco de dados conectado');
    initDatabase();
  }
});

function initDatabase() {
  db.serialize(() => {
    // Tabela de notas fiscais
    db.run(`CREATE TABLE IF NOT EXISTS notas_fiscais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_nota TEXT NOT NULL,
      serie TEXT,
      data_emissao TEXT,
      chave_acesso TEXT UNIQUE,
      emitente_nome TEXT,
      emitente_cnpj TEXT,
      destinatario_nome TEXT,
      destinatario_cnpj TEXT,
      valor_total REAL,
      xml_completo TEXT,
      data_importacao TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de duplicatas
    db.run(`CREATE TABLE IF NOT EXISTS duplicatas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nota_fiscal_id INTEGER,
      numero_duplicata TEXT,
      valor REAL,
      vencimento TEXT,
      previsao_recebimento TEXT,
      FOREIGN KEY (nota_fiscal_id) REFERENCES notas_fiscais(id) ON DELETE CASCADE
    )`);

    // Tabela de títulos de comissão
    db.run(`CREATE TABLE IF NOT EXISTS titulos_comissao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duplicata_id INTEGER,
      nota_fiscal_id INTEGER,
      percentual_comissao REAL,
      valor_comissao REAL,
      status TEXT DEFAULT 'pendente',
      status_pagamento TEXT DEFAULT 'pendente',
      pedido_id INTEGER,
      data_criacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (duplicata_id) REFERENCES duplicatas(id) ON DELETE CASCADE,
      FOREIGN KEY (nota_fiscal_id) REFERENCES notas_fiscais(id) ON DELETE CASCADE,
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
    )`);

    // Tabela de pedidos
    db.run(`CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao TEXT,
      valor_total REAL,
      quantidade_titulos INTEGER,
      status TEXT DEFAULT 'aberto',
      data_criacao TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de notas fiscais de serviço (NFS-e)
    db.run(`CREATE TABLE IF NOT EXISTS notas_fiscais_servico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER,
      numero_nfse TEXT,
      data_emissao TEXT,
      valor REAL,
      status_pagamento TEXT DEFAULT 'aguardando',
      data_pagamento TEXT,
      observacoes TEXT,
      data_criacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
    )`);

    // Verificar e adicionar colunas novas se necessário (migração)
    db.all("PRAGMA table_info(duplicatas)", [], (err, columns) => {
      if (!err && columns) {
        const hasPrevisao = columns.some(col => col.name === 'previsao_recebimento');
        if (!hasPrevisao) {
          db.run("ALTER TABLE duplicatas ADD COLUMN previsao_recebimento TEXT");
        }
      }
    });

    db.all("PRAGMA table_info(titulos_comissao)", [], (err, columns) => {
      if (!err && columns) {
        const hasStatusPagamento = columns.some(col => col.name === 'status_pagamento');
        if (!hasStatusPagamento) {
          db.run("ALTER TABLE titulos_comissao ADD COLUMN status_pagamento TEXT DEFAULT 'pendente'");
        }
      }
    });
  });
}

// Função para calcular previsão de recebimento (dia 20 do mês seguinte ao vencimento)
function calcularPrevisaoRecebimento(vencimento) {
  if (!vencimento) return null;
  
  try {
    const dataVenc = new Date(vencimento);
    // Adicionar 1 mês
    const mesProximo = new Date(dataVenc.getFullYear(), dataVenc.getMonth() + 1, 20);
    return mesProximo.toISOString().split('T')[0];
  } catch (error) {
    return null;
  }
}

// Função para extrair dados do PDF da NF-e
async function extrairDadosPDF(pdfBuffer) {
  try {
    const data = await pdfParse(pdfBuffer);
    const text = data.text;
    
    console.log('=== INÍCIO EXTRAÇÃO PDF ===');
    console.log('Tamanho do texto:', text.length);
    console.log('Primeiros 500 caracteres:', text.substring(0, 500));
    console.log('===========================');

    // Extrair número da nota - múltiplos padrões
    let numeroNota = 'SEM_NUMERO';
    
    // Padrão 1: "NF-e" ou "NOTA FISCAL" seguido de número
    let numeroNotaMatch = text.match(/(?:NF-e|NOTA\s*FISCAL|N\.?\s*F\.?)[:\s]*N[ºª°]?\.?\s*(\d{6,})/i);
    if (numeroNotaMatch) numeroNota = numeroNotaMatch[1];
    
    // Padrão 2: Apenas "Nº" seguido de número
    if (numeroNota === 'SEM_NUMERO') {
      numeroNotaMatch = text.match(/N[ºª°]\.?\s*(\d{6,})/i);
      if (numeroNotaMatch) numeroNota = numeroNotaMatch[1];
    }
    
    // Padrão 3: Procurar número de 6+ dígitos após palavras-chave
    if (numeroNota === 'SEM_NUMERO') {
      numeroNotaMatch = text.match(/(?:NÚMERO|NUMERO|NUM)[:\s]*(\d{6,})/i);
      if (numeroNotaMatch) numeroNota = numeroNotaMatch[1];
    }
    
    console.log('Número da nota encontrado:', numeroNota);

    // Série
    const serieMatch = text.match(/(?:S[ÉE]RIE|SERIE)[:\s]*(\d+)/i);
    const serie = serieMatch ? serieMatch[1] : '1';
    console.log('Série encontrada:', serie);
    
    // Data de emissão
    const dataEmissaoMatch = text.match(/(?:EMISS[ÃA]O|DATA\s*(?:DE\s*)?EMISS[ÃA]O)[:\s]*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i);
    const dataEmissao = dataEmissaoMatch ? dataEmissaoMatch[1].split(/[\/\-]/).reverse().join('-') : new Date().toISOString().split('T')[0];
    console.log('Data emissão:', dataEmissao);
    
    // Chave de acesso - 44 dígitos
    const chaveAcessoMatch = text.match(/(\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4})/);
    const chaveAcesso = chaveAcessoMatch ? chaveAcessoMatch[1].replace(/\s/g, '') : null;
    console.log('Chave de acesso:', chaveAcesso ? 'Encontrada' : 'Não encontrada');
    
    // Emitente - múltiplos padrões
    let emitenteNome = 'NÃO IDENTIFICADO';
    
    // Padrão 1: "RAZÃO SOCIAL" ou "NOME"
    let emitenteMatch = text.match(/(?:RAZ[ÃA]O\s*SOCIAL|NOME\s*(?:EMPRESARIAL)?)[:\s]*([^\n]{5,100})/i);
    if (emitenteMatch) {
      emitenteNome = emitenteMatch[1].trim();
    } else {
      // Padrão 2: "EMITENTE"
      emitenteMatch = text.match(/EMITENTE[:\s]*([^\n]{5,100})/i);
      if (emitenteMatch) emitenteNome = emitenteMatch[1].trim();
    }
    
    // Limpar nome do emitente (remover espaços extras, tabs, etc)
    emitenteNome = emitenteNome.replace(/\s+/g, ' ').trim();
    console.log('Emitente encontrado:', emitenteNome);
    
    // CNPJ do Emitente
    const emitenteCnpjMatch = text.match(/(?:CNPJ|CPF)[:\s]*(\d{2}\.?\d{3}\.?\d{3}[\/\\]?\d{4}[\-]?\d{2})/i);
    const emitenteCnpj = emitenteCnpjMatch ? emitenteCnpjMatch[1].replace(/[^\d]/g, '') : '';
    console.log('CNPJ Emitente:', emitenteCnpj || 'Não encontrado');
    
    // Destinatário/Cliente - múltiplos padrões
    let destinatarioNome = 'NÃO IDENTIFICADO';
    
    // Padrão 1: "DESTINATÁRIO" ou "REMETENTE"
    let destinatarioMatch = text.match(/(?:DESTINAT[ÁA]RIO[\/\\]?REMETENTE|DESTINAT[ÁA]RIO)[:\s]*([^\n]{5,100})/i);
    if (destinatarioMatch) {
      destinatarioNome = destinatarioMatch[1].trim();
    } else {
      // Padrão 2: "CLIENTE" ou "TOMADOR"
      destinatarioMatch = text.match(/(?:CLIENTE|TOMADOR)[:\s]*([^\n]{5,100})/i);
      if (destinatarioMatch) destinatarioNome = destinatarioMatch[1].trim();
    }
    
    // Limpar nome do destinatário
    destinatarioNome = destinatarioNome.replace(/\s+/g, ' ').trim();
    console.log('Destinatário encontrado:', destinatarioNome);
    
    // Segundo CNPJ (geralmente do destinatário)
    const allCnpjMatches = text.match(/(?:CNPJ|CPF)[:\s]*(\d{2}\.?\d{3}\.?\d{3}[\/\\]?\d{4}[\-]?\d{2})/gi);
    let destCnpj = '';
    if (allCnpjMatches && allCnpjMatches.length > 1) {
      const match = allCnpjMatches[1].match(/(\d{2}\.?\d{3}\.?\d{3}[\/\\]?\d{4}[\-]?\d{2})/);
      if (match) destCnpj = match[1].replace(/[^\d]/g, '');
    }
    console.log('CNPJ Destinatário:', destCnpj || 'Não encontrado');
    
    // Valor total (procurar por padrões como "VALOR TOTAL" ou "TOTAL DA NOTA")
    const valorTotalMatch = text.match(/(?:VALOR\s*TOTAL|TOTAL\s*(?:DA\s*)?(?:NOTA|NF)|VL\.?\s*TOTAL)[:\s]*R?\$?\s*([\d.,]+)/i);
    const valorTotal = valorTotalMatch ? parseFloat(valorTotalMatch[1].replace(/\./g, '').replace(',', '.')) : 0;
    console.log('Valor total:', valorTotal);
    
    // Duplicatas - múltiplos padrões
    const duplicatas = [];
    
    // Padrão 1: "001 15/01/2024 R$ 1.000,00"
    const dupRegex1 = /(\d{3}|\d{2}[\/\\]\d{3})\s+(\d{2}[\/\\]\d{2}[\/\\]\d{4})\s+R?\$?\s*([\d.,]+)/gi;
    let dupMatch;
    
    while ((dupMatch = dupRegex1.exec(text)) !== null) {
      const numero = dupMatch[1].replace(/[\/\\]/g, '');
      const vencimentoStr = dupMatch[2];
      const valor = parseFloat(dupMatch[3].replace(/\./g, '').replace(',', '.'));
      
      // Converter data DD/MM/YYYY para YYYY-MM-DD
      const dateParts = vencimentoStr.split(/[\/\\]/);
      const vencimento = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
      
      duplicatas.push({ numero, vencimento, valor });
    }
    
    // Padrão 2: "DUPLICATA 001 ... 15/01/2024 ... 1.000,00"
    if (duplicatas.length === 0) {
      const dupRegex2 = /(?:DUPLICATA|PARC(?:ELA)?)[:\s]*(\d+)[^\d]+([\d\/\\]+)[^\d]+([\d.,]+)/gi;
      while ((dupMatch = dupRegex2.exec(text)) !== null) {
        const numero = dupMatch[1].padStart(3, '0');
        const vencimentoStr = dupMatch[2];
        const valor = parseFloat(dupMatch[3].replace(/\./g, '').replace(',', '.'));
        
        if (vencimentoStr.includes('/') || vencimentoStr.includes('\\')) {
          const dateParts = vencimentoStr.split(/[\/\\]/);
          if (dateParts.length === 3) {
            const vencimento = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
            duplicatas.push({ numero, vencimento, valor });
          }
        }
      }
    }

    const resultado = {
      numeroNota: numeroNota,
      serie: serie,
      dataEmissao: dataEmissao,
      chaveAcesso: chaveAcesso,
      emitenteNome: emitenteNome,
      emitenteCnpj: emitenteCnpj,
      destinatarioNome: destinatarioNome,
      destinatarioCnpj: destCnpj,
      valorTotal: valorTotal,
      duplicatas: duplicatas
    };

    console.log('=== RESULTADO FINAL ===');
    console.log(JSON.stringify(resultado, null, 2));
    console.log('=======================');

    // Se não encontrou duplicatas e tem valor total, criar duplicata padrão
    if (resultado.duplicatas.length === 0 && resultado.valorTotal > 0) {
      const vencimento30dias = new Date();
      vencimento30dias.setDate(vencimento30dias.getDate() + 30);
      resultado.duplicatas.push({
        numero: '001',
        vencimento: vencimento30dias.toISOString().split('T')[0],
        valor: resultado.valorTotal
      });
      console.log('Criada duplicata padrão (venc. 30 dias)');
    }

    return resultado;
  } catch (error) {
    console.error('Erro ao processar PDF:', error);
    throw new Error(`Erro ao processar PDF: ${error.message}. Certifique-se de que é um PDF válido de NF-e.`);
  }
}

// Função para extrair dados do XML da NF-e
async function extrairDadosXML(xmlContent) {
  const parser = new xml2js.Parser({ explicitArray: false });
  
  try {
    const result = await parser.parseStringPromise(xmlContent);
    
    // Navegar pela estrutura do XML da NF-e
    const nfe = result.nfeProc?.NFe?.infNFe || result.NFe?.infNFe;
    
    if (!nfe) {
      throw new Error('Estrutura XML inválida');
    }

    const ide = nfe.ide;
    const emit = nfe.emit;
    const dest = nfe.dest;
    const total = nfe.total?.ICMSTot;
    const cobr = nfe.cobr;

    // Extrair duplicatas
    let duplicatas = [];
    if (cobr?.dup) {
      const dups = Array.isArray(cobr.dup) ? cobr.dup : [cobr.dup];
      duplicatas = dups.map(dup => ({
        numero: dup.nDup,
        valor: parseFloat(dup.vDup),
        vencimento: dup.dVenc
      }));
    }

    const valorTotal = parseFloat(total?.vNF || 0);

    // Se não houver duplicatas e houver valor total, criar duplicata padrão
    if (duplicatas.length === 0 && valorTotal > 0) {
      const vencimento30dias = new Date();
      vencimento30dias.setDate(vencimento30dias.getDate() + 30);
      duplicatas.push({
        numero: '001',
        valor: valorTotal,
        vencimento: vencimento30dias.toISOString().split('T')[0]
      });
      console.log('XML sem duplicatas: criada duplicata padrão com valor total da nota');
    }

    return {
      numeroNota: ide.nNF,
      serie: ide.serie,
      dataEmissao: ide.dhEmi || ide.dEmi,
      chaveAcesso: nfe.$.Id?.replace('NFe', ''),
      emitenteNome: emit.xNome,
      emitenteCnpj: emit.CNPJ,
      destinatarioNome: dest?.xNome || '',
      destinatarioCnpj: dest?.CNPJ || '',
      valorTotal: valorTotal,
      duplicatas: duplicatas
    };
  } catch (error) {
    console.error('Erro ao processar XML:', error);
    throw new Error('Erro ao processar XML: ' + error.message);
  }
}

// Rota para importar XML
app.post('/api/importar-xml', upload.single('xmlFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const percentualComissao = parseFloat(req.body.percentualComissao);
    
    if (!percentualComissao || percentualComissao <= 0 || percentualComissao > 100) {
      return res.status(400).json({ error: 'Percentual de comissão inválido' });
    }

    // Ler arquivo XML
    const xmlContent = fs.readFileSync(req.file.path, 'utf-8');
    
    // Extrair dados
    const dados = await extrairDadosXML(xmlContent);

    // Verificar se nota já existe
    db.get('SELECT id FROM notas_fiscais WHERE chave_acesso = ?', [dados.chaveAcesso], (err, row) => {
      if (row) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Nota fiscal já importada' });
      }

      // Inserir nota fiscal
      db.run(`INSERT INTO notas_fiscais 
        (numero_nota, serie, data_emissao, chave_acesso, emitente_nome, emitente_cnpj, 
         destinatario_nome, destinatario_cnpj, valor_total, xml_completo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dados.numeroNota, dados.serie, dados.dataEmissao, dados.chaveAcesso,
         dados.emitenteNome, dados.emitenteCnpj, dados.destinatarioNome,
         dados.destinatarioCnpj, dados.valorTotal, xmlContent],
        function(err) {
          if (err) {
            fs.unlinkSync(req.file.path);
            return res.status(500).json({ error: 'Erro ao salvar nota fiscal' });
          }

          const notaFiscalId = this.lastID;

          // Inserir duplicatas e títulos de comissão
          const promises = dados.duplicatas.map(dup => {
            return new Promise((resolve, reject) => {
              const previsaoRecebimento = calcularPrevisaoRecebimento(dup.vencimento);
              
              db.run(`INSERT INTO duplicatas (nota_fiscal_id, numero_duplicata, valor, vencimento, previsao_recebimento)
                      VALUES (?, ?, ?, ?, ?)`,
                [notaFiscalId, dup.numero, dup.valor, dup.vencimento, previsaoRecebimento],
                function(err) {
                  if (err) return reject(err);
                  
                  const duplicataId = this.lastID;
                  const valorComissao = (dup.valor * percentualComissao) / 100;

                  db.run(`INSERT INTO titulos_comissao 
                          (duplicata_id, nota_fiscal_id, percentual_comissao, valor_comissao, status_pagamento)
                          VALUES (?, ?, ?, ?, 'pendente')`,
                    [duplicataId, notaFiscalId, percentualComissao, valorComissao],
                    (err) => {
                      if (err) return reject(err);
                      resolve();
                    }
                  );
                }
              );
            });
          });

          Promise.all(promises)
            .then(() => {
              // Buscar os títulos criados para retornar
              db.all(`
                SELECT 
                  tc.id,
                  tc.valor_comissao,
                  tc.percentual_comissao,
                  tc.status_pagamento,
                  nf.numero_nota,
                  nf.destinatario_nome as cliente_nome,
                  d.numero_duplicata,
                  d.valor as valor_duplicata,
                  d.vencimento,
                  d.previsao_recebimento
                FROM titulos_comissao tc
                JOIN notas_fiscais nf ON tc.nota_fiscal_id = nf.id
                JOIN duplicatas d ON tc.duplicata_id = d.id
                WHERE tc.nota_fiscal_id = ?
                ORDER BY d.numero_duplicata
              `, [notaFiscalId], (err, titulos) => {
                fs.unlinkSync(req.file.path);
                
                if (err) {
                  return res.json({ 
                    success: true, 
                    message: 'XML importado com sucesso',
                    notaFiscalId: notaFiscalId,
                    quantidadeTitulos: dados.duplicatas.length
                  });
                }

                res.json({ 
                  success: true, 
                  message: 'XML importado com sucesso',
                  notaFiscalId: notaFiscalId,
                  quantidadeTitulos: dados.duplicatas.length,
                  titulos: titulos
                });
              });
            })
            .catch(error => {
              fs.unlinkSync(req.file.path);
              res.status(500).json({ error: 'Erro ao criar títulos de comissão' });
            });
        }
      );
    });
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// Rota para fazer preview do PDF (não salva no banco)
app.post('/api/preview-pdf', upload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    // Ler arquivo PDF
    const pdfBuffer = fs.readFileSync(req.file.path);
    
    // Extrair dados
    const dados = await extrairDadosPDF(pdfBuffer);
    
    // Deletar arquivo temporário
    fs.unlinkSync(req.file.path);
    
    // Retornar dados extraídos para preview
    res.json({
      success: true,
      dados: dados
    });
    
  } catch (error) {
    console.error('Erro ao fazer preview do PDF:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Erro ao processar PDF: ' + error.message });
  }
});

// Rota para importar PDF (agora recebe dados já extraídos)
app.post('/api/importar-pdf', upload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const percentualComissao = parseFloat(req.body.percentualComissao);
    
    if (!percentualComissao || percentualComissao <= 0 || percentualComissao > 100) {
      return res.status(400).json({ error: 'Percentual de comissão inválido' });
    }

    // Ler arquivo PDF
    const pdfBuffer = fs.readFileSync(req.file.path);
    
    // Extrair dados
    const dados = await extrairDadosPDF(pdfBuffer);

    // Verificar se nota já existe (se tiver chave de acesso)
    if (dados.chaveAcesso) {
      db.get('SELECT id FROM notas_fiscais WHERE chave_acesso = ?', [dados.chaveAcesso], (err, row) => {
        if (row) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: 'Nota fiscal já importada' });
        }
        salvarNotaPDF();
      });
    } else {
      salvarNotaPDF();
    }

    function salvarNotaPDF() {
      // Inserir nota fiscal
      db.run(`INSERT INTO notas_fiscais 
        (numero_nota, serie, data_emissao, chave_acesso, emitente_nome, emitente_cnpj, 
         destinatario_nome, destinatario_cnpj, valor_total, xml_completo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dados.numeroNota, dados.serie, dados.dataEmissao, dados.chaveAcesso,
         dados.emitenteNome, dados.emitenteCnpj, dados.destinatarioNome,
         dados.destinatarioCnpj, dados.valorTotal, 'PDF_IMPORT'],
        function(err) {
          if (err) {
            fs.unlinkSync(req.file.path);
            return res.status(500).json({ error: 'Erro ao salvar nota fiscal' });
          }

          const notaFiscalId = this.lastID;

          // Inserir duplicatas e títulos de comissão
          const promises = dados.duplicatas.map(dup => {
            return new Promise((resolve, reject) => {
              const previsaoRecebimento = calcularPrevisaoRecebimento(dup.vencimento);
              
              db.run(`INSERT INTO duplicatas (nota_fiscal_id, numero_duplicata, valor, vencimento, previsao_recebimento)
                      VALUES (?, ?, ?, ?, ?)`,
                [notaFiscalId, dup.numero, dup.valor, dup.vencimento, previsaoRecebimento],
                function(err) {
                  if (err) return reject(err);
                  
                  const duplicataId = this.lastID;
                  const valorComissao = (dup.valor * percentualComissao) / 100;

                  db.run(`INSERT INTO titulos_comissao 
                          (duplicata_id, nota_fiscal_id, percentual_comissao, valor_comissao, status_pagamento)
                          VALUES (?, ?, ?, ?, 'pendente')`,
                    [duplicataId, notaFiscalId, percentualComissao, valorComissao],
                    (err) => {
                      if (err) return reject(err);
                      resolve();
                    }
                  );
                }
              );
            });
          });

          Promise.all(promises)
            .then(() => {
              // Buscar os títulos criados
              db.all(`
                SELECT 
                  tc.id,
                  tc.valor_comissao,
                  tc.percentual_comissao,
                  tc.status_pagamento,
                  nf.numero_nota,
                  nf.destinatario_nome as cliente_nome,
                  d.numero_duplicata,
                  d.valor as valor_duplicata,
                  d.vencimento,
                  d.previsao_recebimento
                FROM titulos_comissao tc
                JOIN notas_fiscais nf ON tc.nota_fiscal_id = nf.id
                JOIN duplicatas d ON tc.duplicata_id = d.id
                WHERE tc.nota_fiscal_id = ?
                ORDER BY d.numero_duplicata
              `, [notaFiscalId], (err, titulos) => {
                fs.unlinkSync(req.file.path);
                
                res.json({ 
                  success: true, 
                  message: 'PDF importado com sucesso',
                  notaFiscalId: notaFiscalId,
                  quantidadeTitulos: dados.duplicatas.length,
                  titulos: titulos || []
                });
              });
            })
            .catch(error => {
              fs.unlinkSync(req.file.path);
              res.status(500).json({ error: 'Erro ao criar títulos de comissão' });
            });
        }
      );
    }
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// Atualizar valor de comissão de um título
app.put('/api/titulos-comissao/:id', (req, res) => {
  const tituloId = req.params.id;
  const { valorComissao, statusPagamento } = req.body;

  // Verificar se título não está em pedido
  db.get('SELECT pedido_id FROM titulos_comissao WHERE id = ?', [tituloId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar título' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Título não encontrado' });
    }

    if (row.pedido_id && valorComissao !== undefined) {
      return res.status(400).json({ error: 'Não é possível editar valor de título já vinculado a um pedido' });
    }

    // Preparar campos para atualização
    let updates = [];
    let values = [];

    if (valorComissao !== undefined && valorComissao >= 0) {
      updates.push('valor_comissao = ?');
      values.push(valorComissao);
    }

    if (statusPagamento !== undefined) {
      updates.push('status_pagamento = ?');
      values.push(statusPagamento);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    values.push(tituloId);
    const sql = `UPDATE titulos_comissao SET ${updates.join(', ')} WHERE id = ?`;

    db.run(sql, values, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao atualizar título' });
      }
      res.json({ success: true, message: 'Título atualizado com sucesso' });
    });
  });
});

// Obter detalhes de um título específico
app.get('/api/titulos-comissao/:id', (req, res) => {
  const tituloId = req.params.id;
  
  const sql = `
    SELECT 
      tc.*,
      nf.numero_nota,
      nf.emitente_nome,
      nf.destinatario_nome as cliente_nome,
      d.numero_duplicata,
      d.valor as valor_duplicata,
      d.vencimento,
      d.previsao_recebimento
    FROM titulos_comissao tc
    JOIN notas_fiscais nf ON tc.nota_fiscal_id = nf.id
    JOIN duplicatas d ON tc.duplicata_id = d.id
    WHERE tc.id = ?
  `;
  
  db.get(sql, [tituloId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar título' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Título não encontrado' });
    }
    res.json(row);
  });
});

// Excluir nota fiscal e todos os títulos vinculados
app.delete('/api/notas-fiscais/:id', (req, res) => {
  const notaId = req.params.id;

  // Verificar se há títulos em pedidos
  db.get(`
    SELECT COUNT(*) as count 
    FROM titulos_comissao 
    WHERE nota_fiscal_id = ? AND pedido_id IS NOT NULL
  `, [notaId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao verificar títulos' });
    }

    if (row.count > 0) {
      return res.status(400).json({ 
        error: 'Não é possível excluir. Existem títulos desta nota vinculados a pedidos.' 
      });
    }

    // Excluir nota (CASCADE deletará duplicatas e títulos automaticamente)
    db.run('DELETE FROM notas_fiscais WHERE id = ?', [notaId], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Erro ao excluir nota fiscal' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Nota fiscal não encontrada' });
      }

      res.json({ 
        success: true, 
        message: 'Nota fiscal e títulos excluídos com sucesso' 
      });
    });
  });
});

// Listar notas fiscais
app.get('/api/notas-fiscais', (req, res) => {
  db.all(`SELECT id, numero_nota, serie, data_emissao, emitente_nome, 
          destinatario_nome, valor_total, data_importacao
          FROM notas_fiscais ORDER BY data_importacao DESC`, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar notas fiscais' });
    }
    res.json(rows);
  });
});

// Listar títulos de comissão
app.get('/api/titulos-comissao', (req, res) => {
  const sql = `
    SELECT 
      tc.id,
      tc.valor_comissao,
      tc.percentual_comissao,
      tc.status,
      tc.status_pagamento,
      tc.pedido_id,
      tc.data_criacao,
      nf.numero_nota,
      nf.emitente_nome,
      nf.destinatario_nome as cliente_nome,
      d.numero_duplicata,
      d.valor as valor_duplicata,
      d.vencimento,
      d.previsao_recebimento
    FROM titulos_comissao tc
    JOIN notas_fiscais nf ON tc.nota_fiscal_id = nf.id
    JOIN duplicatas d ON tc.duplicata_id = d.id
    ORDER BY tc.data_criacao DESC
  `;
  
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar títulos' });
    }
    res.json(rows);
  });
});

// Criar pedido com títulos selecionados
app.post('/api/pedidos', (req, res) => {
  const { descricao, titulosIds } = req.body;

  if (!titulosIds || titulosIds.length === 0) {
    return res.status(400).json({ error: 'Selecione pelo menos um título' });
  }

  // Buscar valor total dos títulos
  const placeholders = titulosIds.map(() => '?').join(',');
  db.all(`SELECT SUM(valor_comissao) as total FROM titulos_comissao 
          WHERE id IN (${placeholders}) AND pedido_id IS NULL`,
    titulosIds, (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao calcular total' });
      }

      const valorTotal = rows[0].total || 0;

      // Criar pedido
      db.run(`INSERT INTO pedidos (descricao, valor_total, quantidade_titulos)
              VALUES (?, ?, ?)`,
        [descricao, valorTotal, titulosIds.length],
        function(err) {
          if (err) {
            return res.status(500).json({ error: 'Erro ao criar pedido' });
          }

          const pedidoId = this.lastID;

          // Atualizar títulos com o pedido_id
          db.run(`UPDATE titulos_comissao SET pedido_id = ?, status = 'em_pedido'
                  WHERE id IN (${placeholders})`,
            [pedidoId, ...titulosIds],
            (err) => {
              if (err) {
                return res.status(500).json({ error: 'Erro ao vincular títulos' });
              }

              res.json({ 
                success: true, 
                pedidoId: pedidoId,
                message: 'Pedido criado com sucesso'
              });
            }
          );
        }
      );
    }
  );
});

// Listar pedidos
app.get('/api/pedidos', (req, res) => {
  db.all(`SELECT * FROM pedidos ORDER BY data_criacao DESC`, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar pedidos' });
    }
    res.json(rows);
  });
});

// Detalhes do pedido
app.get('/api/pedidos/:id', (req, res) => {
  const pedidoId = req.params.id;

  db.get('SELECT * FROM pedidos WHERE id = ?', [pedidoId], (err, pedido) => {
    if (err || !pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    db.all(`
      SELECT 
        tc.*,
        nf.numero_nota,
        nf.emitente_nome,
        d.numero_duplicata,
        d.valor as valor_duplicata
      FROM titulos_comissao tc
      JOIN notas_fiscais nf ON tc.nota_fiscal_id = nf.id
      JOIN duplicatas d ON tc.duplicata_id = d.id
      WHERE tc.pedido_id = ?
    `, [pedidoId], (err, titulos) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao buscar títulos' });
      }

      res.json({
        pedido: pedido,
        titulos: titulos
      });
    });
  });
});

// ========== ROTAS PARA NOTAS FISCAIS DE SERVIÇO (NFS-e) ==========

// Listar todas as NFS-e
app.get('/api/nfse', (req, res) => {
  const sql = `
    SELECT 
      nfse.*,
      p.descricao as pedido_descricao,
      p.valor_total as pedido_valor
    FROM notas_fiscais_servico nfse
    LEFT JOIN pedidos p ON nfse.pedido_id = p.id
    ORDER BY nfse.data_criacao DESC
  `;
  
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar NFS-e' });
    }
    res.json(rows);
  });
});

// Obter detalhes de uma NFS-e
app.get('/api/nfse/:id', (req, res) => {
  const nfseId = req.params.id;
  
  const sql = `
    SELECT 
      nfse.*,
      p.descricao as pedido_descricao,
      p.valor_total as pedido_valor,
      p.quantidade_titulos
    FROM notas_fiscais_servico nfse
    LEFT JOIN pedidos p ON nfse.pedido_id = p.id
    WHERE nfse.id = ?
  `;
  
  db.get(sql, [nfseId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar NFS-e' });
    }
    if (!row) {
      return res.status(404).json({ error: 'NFS-e não encontrada' });
    }
    res.json(row);
  });
});

// Criar nova NFS-e
app.post('/api/nfse', (req, res) => {
  const { pedidoId, numeroNfse, dataEmissao, valor, statusPagamento, observacoes } = req.body;

  if (!numeroNfse || !dataEmissao || !valor) {
    return res.status(400).json({ error: 'Número, data de emissão e valor são obrigatórios' });
  }

  // Verificar se pedido existe (se informado)
  if (pedidoId) {
    db.get('SELECT id FROM pedidos WHERE id = ?', [pedidoId], (err, row) => {
      if (err || !row) {
        return res.status(400).json({ error: 'Pedido não encontrado' });
      }
      inserirNfse();
    });
  } else {
    inserirNfse();
  }

  function inserirNfse() {
    db.run(`
      INSERT INTO notas_fiscais_servico 
      (pedido_id, numero_nfse, data_emissao, valor, status_pagamento, observacoes)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [pedidoId || null, numeroNfse, dataEmissao, valor, statusPagamento || 'aguardando', observacoes || ''],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Erro ao criar NFS-e' });
      }
      res.json({ 
        success: true, 
        id: this.lastID,
        message: 'NFS-e criada com sucesso' 
      });
    });
  }
});

// Atualizar NFS-e
app.put('/api/nfse/:id', (req, res) => {
  const nfseId = req.params.id;
  const { pedidoId, numeroNfse, dataEmissao, valor, statusPagamento, dataPagamento, observacoes } = req.body;

  let updates = [];
  let values = [];

  if (pedidoId !== undefined) {
    updates.push('pedido_id = ?');
    values.push(pedidoId || null);
  }
  if (numeroNfse) {
    updates.push('numero_nfse = ?');
    values.push(numeroNfse);
  }
  if (dataEmissao) {
    updates.push('data_emissao = ?');
    values.push(dataEmissao);
  }
  if (valor !== undefined) {
    updates.push('valor = ?');
    values.push(valor);
  }
  if (statusPagamento) {
    updates.push('status_pagamento = ?');
    values.push(statusPagamento);
  }
  if (dataPagamento !== undefined) {
    updates.push('data_pagamento = ?');
    values.push(dataPagamento || null);
  }
  if (observacoes !== undefined) {
    updates.push('observacoes = ?');
    values.push(observacoes);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  values.push(nfseId);
  const sql = `UPDATE notas_fiscais_servico SET ${updates.join(', ')} WHERE id = ?`;

  db.run(sql, values, function(err) {
    if (err) {
      return res.status(500).json({ error: 'Erro ao atualizar NFS-e' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'NFS-e não encontrada' });
    }
    res.json({ success: true, message: 'NFS-e atualizada com sucesso' });
  });
});

// Excluir NFS-e
app.delete('/api/nfse/:id', (req, res) => {
  const nfseId = req.params.id;

  db.run('DELETE FROM notas_fiscais_servico WHERE id = ?', [nfseId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Erro ao excluir NFS-e' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'NFS-e não encontrada' });
    }
    res.json({ success: true, message: 'NFS-e excluída com sucesso' });
  });
});

// Dashboard - Estatísticas
app.get('/api/dashboard', (req, res) => {
  const stats = {};

  db.get('SELECT COUNT(*) as total, SUM(valor_total) as valor FROM notas_fiscais', 
    [], (err, nfStats) => {
      stats.notasFiscais = nfStats;

      db.get(`SELECT COUNT(*) as total, SUM(valor_comissao) as valor, 
              COUNT(CASE WHEN status = 'pendente' THEN 1 END) as pendentes
              FROM titulos_comissao`, [], (err, tcStats) => {
        stats.titulosComissao = tcStats;

        db.get(`SELECT COUNT(*) as total, SUM(valor_total) as valor,
                COUNT(CASE WHEN status = 'aberto' THEN 1 END) as abertos
                FROM pedidos`, [], (err, pedStats) => {
          stats.pedidos = pedStats;

          res.json(stats);
        });
      });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
