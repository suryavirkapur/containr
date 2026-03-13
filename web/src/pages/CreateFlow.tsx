import { A } from '@solidjs/router';
import { PageTitle, Panel } from '../components/Plain';

const repoTypes = [
  ['web_service', 'web service'],
  ['private_service', 'private service'],
  ['background_worker', 'background worker'],
  ['cron_job', 'cron job'],
] as const;

const templateTypes = [
  ['postgresql', 'postgresql'],
  ['redis', 'valkey'],
  ['mariadb', 'mariadb'],
  ['qdrant', 'qdrant'],
  ['rabbitmq', 'rabbitmq'],
] as const;

const CreateFlow = () => (
  <div class='stack'>
    <PageTitle title='new service' subtitle='Pick a repository-backed service or a managed template.' />

    <Panel title='repository-backed services'>
      <div class='table-wrap'>
        <table>
          <tbody>
            {repoTypes.map(([value, label]) => (
              <tr>
                <th>{label}</th>
                <td>
                  <A href={`/services/new/repo?type=${value}`}>continue</A>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>

    <Panel title='managed templates'>
      <div class='table-wrap'>
        <table>
          <tbody>
            {templateTypes.map(([value, label]) => (
              <tr>
                <th>{label}</th>
                <td>
                  <A href={`/services/new/template?type=${value}`}>continue</A>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  </div>
);

export default CreateFlow;
