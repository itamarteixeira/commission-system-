const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xml2js = require('xml2js');
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
      FOREIGN KEY (nota_fiscal_id) REFERENCES notas_fiscais(id)
    )`);

    // Tabela de títulos de comissão
    db.run(`CREATE TABLE IF NOT EXISTS titulos_comissao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duplicata_id INTEGER,
      nota_fiscal_id INTEGER,
      percentual_comissao REAL,
      valor_comissao REAL,
      status TEXT DEFAULT 'pendente',
      pedido_id INTEGER,
      data_criacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (duplicata_id) REFERENCES duplicatas(id),
      FOREIGN KEY (nota_fiscal_id) REFERENCES notas_fiscais(id),
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
  });
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

    return {
      numeroNota: ide.nNF,
      serie: ide.serie,
      dataEmissao: ide.dhEmi || ide.dEmi,
      chaveAcesso: nfe.$.Id?.replace('NFe', ''),
      emitenteNome: emit.xNome,
      emitenteCnpj: emit.CNPJ,
      destinatarioNome: dest?.xNome || '',
      destinatarioCnpj: dest?.CNPJ || '',
      valorTotal: parseFloat(total?.vNF || 0),
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
              db.run(`INSERT INTO duplicatas (nota_fiscal_id, numero_duplicata, valor, vencimento)
                      VALUES (?, ?, ?, ?)`,
                [notaFiscalId, dup.numero, dup.valor, dup.vencimento],
                function(err) {
                  if (err) return reject(err);
                  
                  const duplicataId = this.lastID;
                  const valorComissao = (dup.valor * percentualComissao) / 100;

                  db.run(`INSERT INTO titulos_comissao 
                          (duplicata_id, nota_fiscal_id, percentual_comissao, valor_comissao)
                          VALUES (?, ?, ?, ?)`,
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
                  nf.numero_nota,
                  d.numero_duplicata,
                  d.valor as valor_duplicata,
                  d.vencimento
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

// Atualizar valor de comissão de um título
app.put('/api/titulos-comissao/:id', (req, res) => {
  const tituloId = req.params.id;
  const { valorComissao } = req.body;

  if (!valorComissao || valorComissao < 0) {
    return res.status(400).json({ error: 'Valor de comissão inválido' });
  }

  // Verificar se título não está em pedido
  db.get('SELECT pedido_id FROM titulos_comissao WHERE id = ?', [tituloId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar título' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Título não encontrado' });
    }

    if (row.pedido_id) {
      return res.status(400).json({ error: 'Não é possível editar título já vinculado a um pedido' });
    }

    // Atualizar valor
    db.run('UPDATE titulos_comissao SET valor_comissao = ? WHERE id = ?',
      [valorComissao, tituloId],
      (err) => {
        if (err) {
          return res.status(500).json({ error: 'Erro ao atualizar título' });
        }
        res.json({ success: true, message: 'Valor atualizado com sucesso' });
      }
    );
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
      tc.pedido_id,
      tc.data_criacao,
      nf.numero_nota,
      nf.emitente_nome,
      d.numero_duplicata,
      d.valor as valor_duplicata,
      d.vencimento
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
