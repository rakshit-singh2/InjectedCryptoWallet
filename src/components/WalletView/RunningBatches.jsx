import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from 'antd';
import { walletApi } from '../../helpers/walletApi';

const POLL_MS = 2000;

/** Shows batches (EIP-5792) that are still sending, each with a "Stop batch" control. */
function RunningBatches() {
  const [batches, setBatches] = useState([]);
  const [stopping, setStopping] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setBatches(await walletApi.listRunningBatches());
    } catch {
      // The banner is informational; a failed poll just keeps the last list.
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const stop = async (batch) => {
    setStopping(batch.origin);
    setError('');
    try {
      await walletApi.stopBatch(batch.origin, batch.id);
      await load();
    } catch (stopError) {
      setError(stopError.message);
    } finally {
      setStopping(null);
    }
  };

  if (!batches.length) {
    return null;
  }

  return (
    <div className="running-batches">
      {batches.map((batch) => {
        const testKey = encodeURIComponent(batch.origin);
        return (
          <Alert
            key={`${batch.origin}\n${batch.id}`}
            type="info"
            showIcon
            data-testid={`running-batch-${testKey}`}
            message={<span style={{ wordBreak: 'break-all' }}>{batch.origin} is sending a batch</span>}
            description={
              <>
                <div>
                  {batch.confirmed} of {batch.total} confirmed, {batch.sent} sent. Stopping cancels the calls not yet sent; sent transactions
                  can&apos;t be recalled.
                </div>
                <Button
                  data-testid={`stop-batch-button-${testKey}`}
                  danger
                  size="small"
                  style={{ marginTop: 6 }}
                  loading={stopping === batch.origin}
                  onClick={() => stop(batch)}
                >
                  Stop batch
                </Button>
              </>
            }
          />
        );
      })}
      {error && <Alert type="error" showIcon message={error} />}
    </div>
  );
}

export default RunningBatches;
