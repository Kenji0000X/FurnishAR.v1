import Diagnostics from './Diagnostics.js';

export const metadata = {
  title: 'Device check — FurnishAR',
  description: 'Which FurnishAR experience this phone can run: tracked AR, AI-assisted or photo measurement, or a tape measure.',
  robots: { index: false, follow: false }
};

/*
   Why this page exists.

   The room scanner shipped broken once already, and the reason it survived
   every check was that nothing in this repo could answer one question: what
   does the ACTUAL phone support? CI has no camera, no WebXR and no AR
   hardware, so every test ran against a simulation of a device rather than a
   device.

   This page asks the phone directly and prints the answer in words a person
   can read out or screenshot. It is not for shoppers — it is the thing to
   open when somebody says "the scanner does not work", so the next step is
   decided by what the hardware reports rather than by guessing.

   noindex, because it is a workshop tool and not part of the product.
*/
export default function DiagnosePage() {
  return (
    <section className="view active">
      <div className="diagnose">
        <p className="eyebrow">Workshop tool</p>
        <h1>Can this phone use FurnishAR?</h1>
        <p className="diagnose-intro">
          Open this on the phone that is having trouble. Nothing here is stored or
          sent anywhere — it asks the browser a list of questions and prints what
          it says back.
        </p>
        <Diagnostics />
      </div>
    </section>
  );
}
