import { useEffect, useState } from 'react';
import { Alert, Button, Spin, Typography, message } from 'antd';
import { useNavigate } from 'react-router';
import { walletApi } from '../helpers/walletApi';

const { Title, Paragraph } = Typography;

const label = (minutes) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`);

function Settings() {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    walletApi.getPreferences().then(setPrefs, (loadError) => setError(loadError.message));
  }, []);

  const save = async (autoLockMinutes) => {
    setSaving(true);
    try {
      setPrefs(await walletApi.setPreferences({ autoLockMinutes }));
      message.success(`Auto-lock set to ${label(autoLockMinutes)}`);
    } catch (saveError) {
      message.error(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="content" style={{ width: '100%', textAlign: 'left' }}>
      <Button data-testid="settings-back-button" onClick={() => navigate('/')}>
        Back to wallet
      </Button>
      <Title level={3}>Settings</Title>
      <Title level={5} id="auto-lock-label">Auto-lock</Title>
      <Paragraph type="secondary">Lock the wallet after this much inactivity. Locking also happens when the browser closes.</Paragraph>
      {error && <Alert type="error" showIcon message={error} />}
      {!prefs ? (
        !error && <Spin />
      ) : (
        <select
          data-testid="auto-lock-select"
          aria-labelledby="auto-lock-label"
          className="settings-select"
          disabled={saving}
          value={prefs.autoLockMinutes}
          onChange={(event) => save(Number(event.target.value))}
        >
          {prefs.autoLockChoices.map((minutes) => (
            <option key={minutes} value={minutes}>
              {label(minutes)}
            </option>
          ))}
        </select>
      )}
    </main>
  );
}

export default Settings;
