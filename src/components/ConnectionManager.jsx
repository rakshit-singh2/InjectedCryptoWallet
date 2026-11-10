import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Empty, Spin, Typography, message } from 'antd';
import { useNavigate } from 'react-router';
import { walletApi } from '../helpers/walletApi';
import { shortAddress } from '../helpers/rpc';

const { Title, Text } = Typography;

function ConnectionManager() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revokingOrigin, setRevokingOrigin] = useState(null);
  const [error, setError] = useState('');

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setConnections(await walletApi.listPermissions());
    } catch (loadError) {
      setError(loadError.message || 'Failed to load connected sites.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const handleRevoke = async (origin) => {
    setRevokingOrigin(origin);
    try {
      await walletApi.revokePermission(origin);
      setConnections((current) => current.filter((connection) => connection.origin !== origin));
      message.success(`Disconnected ${origin}`);
    } catch (revokeError) {
      message.error(revokeError.message || 'Failed to disconnect site.');
    } finally {
      setRevokingOrigin(null);
    }
  };

  return (
    <main className="content" style={{ width: '100%' }}>
      <Button data-testid="connections-back-button" onClick={() => navigate('/')}>
        Back to wallet
      </Button>
      <Title level={3}>Connected Sites</Title>
      <Text>These sites can see the account addresses you approved and request signatures. Disconnect any site to revoke access.</Text>

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>
      ) : error ? (
        <Card style={{ marginTop: 16 }}>
          <Text type="danger">{error}</Text>
          <Button data-testid="connections-retry-button" onClick={loadConnections} style={{ marginLeft: 12 }}>
            Retry
          </Button>
        </Card>
      ) : connections.length === 0 ? (
        <Empty description="No connected sites" />
      ) : (
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          {connections.map(({ origin, accounts }) => (
            <Card key={origin} size="small">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div style={{ textAlign: 'left', wordBreak: 'break-all' }}>
                  <Text strong>{origin}</Text>
                  {accounts.map((account) => (
                    <div key={account}><Text type="secondary">{shortAddress(account)}</Text></div>
                  ))}
                </div>
                <Button
                  data-testid={`revoke-connection-${encodeURIComponent(origin)}`}
                  danger
                  loading={revokingOrigin === origin}
                  disabled={revokingOrigin !== null && revokingOrigin !== origin}
                  onClick={() => handleRevoke(origin)}
                >
                  Disconnect
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}

export default ConnectionManager;
